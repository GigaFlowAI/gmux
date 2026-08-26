//! NDJSON control socket on `mux.sock` (mode 0o600).
//!
//! Request: `{"id","method","params"}`.
//! Reply: `{"id","result"}` or `{"id","error":{"code","message","fix"}}`.
//! Events: `{"event":"pane.created","body":{...}}`.
//!
//! Method ownership
//! ----------------
//! mux (client → mux): ping, pane.spawn, pane.close, tab.close, peel (fast),
//!   pane.send_keys, pane.list, session.snapshot, client.attach
//! intel (mux originates, intel replies on `id`):
//!   prompt.extract (20 ms), context.pack (500 ms),
//!   classify.intent (30_000 ms = CLASSIFY_TIMEOUT_MS),
//!   organize.plan (120_000 ms = ORGANIZE_TIMEOUT_MS)
//! intel → mux: pane.report_semantics, guardian.broadcast (agent panes only)
//!
//! Peel is mux-local and must not await extract. A hung sidecar cannot block
//! ctrl+t. `session.snapshot` is mux-assembled (layout + last intel patches).

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::net::unix::OwnedWriteHalf;

/// Deadlines (ms) — keep in sync with `src/services/mux-client.ts`.
const EXTRACT_TIMEOUT: Duration = Duration::from_millis(20);
const CLASSIFY_TIMEOUT: Duration = Duration::from_millis(30_000);
const ORGANIZE_TIMEOUT: Duration = Duration::from_millis(120_000);

struct IntelHub {
    writer: tokio::sync::Mutex<Option<Arc<tokio::sync::Mutex<OwnedWriteHalf>>>>,
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

impl IntelHub {
    fn new() -> Self {
        Self {
            writer: tokio::sync::Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    async fn attach(&self, writer: Arc<tokio::sync::Mutex<OwnedWriteHalf>>) {
        *self.writer.lock().await = Some(writer);
    }

    async fn detach(&self) {
        *self.writer.lock().await = None;
        self.pending.lock().expect("pending").clear();
    }

    fn complete(&self, id: &str, value: Value) {
        if let Some(tx) = self.pending.lock().expect("pending").remove(id) {
            let _ = tx.send(value);
        }
    }

    /// Mux-originated RPC. Peel does not use this (fast path). Timeouts:
    /// extract 20ms, pack 500ms, classify 30s, organize 120s.
    async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, MuxError> {
        let writer = self.writer.lock().await.clone();
        let Some(writer) = writer else {
            return Err(MuxError::rpc(
                "intel_down",
                "intel sidecar is down",
                "Start `gmux daemon --sidecar`. Peel still works without it.",
            ));
        };
        let id = format!("ex_{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().expect("pending").insert(id.clone(), tx);
        write_json(
            &writer,
            json!({"id": id, "method": method, "params": params}),
        )
        .await
        .map_err(|e| {
            MuxError::rpc(
                "io",
                &format!("intel write failed: {e}"),
                "Restart the sidecar (`gmux daemon --sidecar`)",
            )
        })?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => intel_reply_result(&v),
            Ok(Err(_)) => Err(MuxError::rpc(
                "intel_down",
                "intel sidecar dropped the reply",
                "Restart `gmux daemon --sidecar`",
            )),
            Err(_) => {
                self.pending.lock().expect("pending").remove(&id);
                Err(MuxError::rpc(
                    "timeout",
                    &format!("{method} timed out"),
                    "The sidecar hung; peel still works. Restart `gmux daemon --sidecar`.",
                ))
            }
        }
    }

    async fn extract(&self, grid: Value) -> Result<ExtractReply, ExtractError> {
        match self
            .call("prompt.extract", json!({ "grid": grid }), EXTRACT_TIMEOUT)
            .await
        {
            Ok(v) => ExtractReply::from_value(&v).ok_or(ExtractError::Malformed),
            Err(e) if e.code() == "timeout" => Err(ExtractError::Timeout),
            Err(_) => Err(ExtractError::Down),
        }
    }

    async fn pack(&self, params: Value) -> Result<crate::peel::PackReply, crate::peel::PackError> {
        match self
            .call("context.pack", params, crate::peel::PACK_TIMEOUT)
            .await
        {
            Ok(v) => {
                crate::peel::PackReply::from_value(&v).ok_or(crate::peel::PackError::Malformed)
            }
            Err(e) if e.code() == "timeout" => Err(crate::peel::PackError::Timeout),
            Err(_) => Err(crate::peel::PackError::Down),
        }
    }
}

fn _deadline_table() {
    // Referenced so the table constants stay compiled in.
    let _ = (
        EXTRACT_TIMEOUT,
        crate::peel::PACK_TIMEOUT,
        CLASSIFY_TIMEOUT,
        ORGANIZE_TIMEOUT,
    );
}

use crate::lock::Lock;
use crate::paths::Paths;
use crate::peel::{ExtractError, ExtractReply, PeelSpawn};
use crate::peer::{self, CallerClass};
use crate::session::{Mux, MuxError, SpawnOpts, TabSpec};

pub async fn run(paths: Paths, lock: Lock) -> std::io::Result<()> {
    // Mux first: mint token + bind mux.sock, then spawn the sidecar.
    let (token, listener) = prepare_listener(&paths)?;
    spawn_sidecar();

    let mux = Arc::new(Mutex::new(Mux::new(paths.clone(), token)));
    let lock = Arc::new(Mutex::new(lock));
    let hub = Arc::new(IntelHub::new());
    _deadline_table();

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let mux = mux.clone();
                let lock = lock.clone();
                let hub = hub.clone();
                tokio::spawn(async move {
                    if let Err(err) = handle_client(mux, lock, hub, stream).await {
                        eprintln!("gmuxd client: {err}");
                    }
                });
            }
            _ = shutdown_signal() => break,
        }
    }

    let _ = std::fs::remove_file(paths.socket_path());
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(s) => s,
                Err(_) => {
                    ctrl_c.await.ok();
                    return;
                }
            };
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
        return;
    }
    #[cfg(not(unix))]
    {
        ctrl_c.await.ok();
    }
}

fn mint_token(paths: &Paths) -> std::io::Result<String> {
    let token = ulid::Ulid::new().to_string();
    let path = paths.intel_token_path();
    std::fs::write(&path, &token)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(token)
}

/// Mint `intel.token` and bind `mux.sock` (mode 0o600). Sidecar spawn must
/// happen *after* this returns so hello can present the token.
fn prepare_listener(paths: &Paths) -> std::io::Result<(String, UnixListener)> {
    let token = mint_token(paths)?;
    let sock = paths.socket_path();
    if sock.exists() {
        let _ = std::fs::remove_file(&sock);
    }
    paths.ensure_dir()?;
    let listener = UnixListener::bind(&sock)?;
    std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))?;
    Ok((token, listener))
}

/// `GMUX_PATH` if it is a file, else `gmux` on PATH. Missing is fail-open.
pub(crate) fn find_gmux_from(gmux_path: Option<&str>, path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = gmux_path {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    let path = path?;
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let cand = PathBuf::from(dir).join("gmux");
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn find_gmux() -> Option<PathBuf> {
    find_gmux_from(
        std::env::var("GMUX_PATH").ok().as_deref(),
        std::env::var("PATH").ok().as_deref(),
    )
}

fn spawn_sidecar() {
    if let Some(gmux) = find_gmux() {
        spawn_sidecar_bin(&gmux);
    }
}

pub(crate) fn spawn_sidecar_bin(gmux: &Path) {
    let _ = Command::new(gmux)
        .args(["daemon", "--sidecar"])
        .env("GMUX_CHILD", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// Map an intel NDJSON reply to Ok(result) or Err(error). An `{id, error}`
/// line is never success.
pub(crate) fn intel_reply_result(value: &Value) -> Result<Value, MuxError> {
    if let Some(err) = value.get("error") {
        return Err(MuxError::rpc(
            err.get("code")
                .and_then(Value::as_str)
                .unwrap_or("intel_error"),
            err.get("message")
                .and_then(Value::as_str)
                .unwrap_or("intel error"),
            err.get("fix")
                .and_then(Value::as_str)
                .unwrap_or("Restart `gmux daemon --sidecar`"),
        ));
    }
    match value.get("result") {
        Some(result) => Ok(result.clone()),
        None => Err(MuxError::rpc(
            "intel_error",
            "intel reply missing result",
            "Restart `gmux daemon --sidecar`",
        )),
    }
}

#[derive(Debug, Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

struct Conn {
    class: Result<CallerClass, String>,
    client_id: Option<String>,
    peer_pid: u32,
    env_pane_id: Option<String>,
    subscribed: bool,
}

async fn handle_client(
    mux: Arc<Mutex<Mux>>,
    lock: Arc<Mutex<Lock>>,
    hub: Arc<IntelHub>,
    stream: tokio::net::UnixStream,
) -> std::io::Result<()> {
    let peer_pid = match peer::peer_pid(stream.as_raw_fd()) {
        Ok(pid) if pid != 0 => pid,
        _ => 0,
    };
    let env_pane_id = if peer_pid == 0 {
        None
    } else {
        peer::env_var_of(peer_pid, "GMUX_PANE_ID")
    };
    let class = {
        let guard = mux.lock().expect("mux");
        peer::classify(
            peer_pid,
            &guard.pane_trees(),
            false,
            env_pane_id.as_deref(),
            guard.intel_pid,
        )
        .map_err(|e| e.to_string())
    };

    let mut conn = Conn {
        class,
        client_id: None,
        peer_pid,
        env_pane_id,
        subscribed: false,
    };

    let (reader, writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(err) => {
                write_json(
                    &writer,
                    json!({
                        "id": null,
                        "error": {
                            "code": "invalid_request",
                            "message": format!("invalid JSON: {err}"),
                            "fix": "Send NDJSON {\"id\",\"method\",\"params\"}"
                        }
                    }),
                )
                .await?;
                continue;
            }
        };

        if parsed.get("method").is_none()
            && (parsed.get("result").is_some() || parsed.get("error").is_some())
        {
            if let Some(id) = parsed.get("id") {
                let key = match id {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                hub.complete(&key, parsed);
            }
            continue;
        }

        let req: Request = match serde_json::from_value(parsed) {
            Ok(r) => r,
            Err(err) => {
                write_json(
                    &writer,
                    json!({
                        "id": null,
                        "error": {
                            "code": "invalid_request",
                            "message": format!("invalid request: {err}"),
                            "fix": "Send NDJSON {\"id\",\"method\",\"params\"}"
                        }
                    }),
                )
                .await?;
                continue;
            }
        };

        if matches!(conn.class, Ok(CallerClass::Intel))
            && req.method != "hello"
            && !allowed(CallerClass::Intel, &req.method)
        {
            continue;
        }

        let reply = dispatch(&mux, &lock, &hub, &mut conn, &req, &writer).await;
        write_json(&writer, reply).await?;
    }
    if matches!(conn.class, Ok(CallerClass::Intel)) {
        {
            let mut guard = mux.lock().expect("mux");
            guard.intel_connected = false;
            guard.intel_pid = None;
        }
        if let Ok(mut held) = lock.lock() {
            let _ = held.set_intel_pid(None);
        }
        hub.detach().await;
    }
    if let Some(id) = conn.client_id.take() {
        mux.lock().expect("mux").detach_client(&id);
    }
    Ok(())
}

async fn dispatch(
    mux: &Arc<Mutex<Mux>>,
    lock: &Arc<Mutex<Lock>>,
    hub: &Arc<IntelHub>,
    conn: &mut Conn,
    req: &Request,
    writer: &Arc<tokio::sync::Mutex<OwnedWriteHalf>>,
) -> Value {
    match req.method.as_str() {
        "hello" => handle_hello(mux, lock, hub, conn, req, writer).await,
        "ping" => ok(&req.id, json!({"ok": true})),
        "client.attach" => handle_attach(mux, conn, req).await,
        "client.focus" => gated(conn, req, "client.focus", |conn| {
            let Some(client_id) = conn.client_id.clone() else {
                return error(
                    &req.id,
                    "invalid_request",
                    "client.focus requires an attached TUI",
                    "Call client.attach first",
                );
            };
            let pane_id = req
                .params
                .get("paneId")
                .and_then(Value::as_str)
                .unwrap_or("");
            match mux.lock().expect("mux").focus_client(&client_id, pane_id) {
                Ok(()) => ok(&req.id, json!({"ok": true})),
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "session.snapshot" => gated(conn, req, "session.snapshot", |conn| {
            let guard = mux.lock().expect("mux");
            let mut snap = guard.snapshot();
            if let Ok(CallerClass::Pane) = conn.class {
                if let Some(ws) = pane_workspace(&guard, conn.env_pane_id.as_deref()) {
                    filter_snapshot_to_workspace(&mut snap, &ws);
                }
            }
            ok(&req.id, snap)
        }),
        "pane.list" => gated(conn, req, "pane.list", |conn| {
            let guard = mux.lock().expect("mux");
            let mut panes = guard.list_panes();
            if let Ok(CallerClass::Pane) = conn.class {
                if let Some(ws) = pane_workspace(&guard, conn.env_pane_id.as_deref()) {
                    panes.retain(|p| {
                        p.get("workspaceId").and_then(Value::as_str) == Some(ws.as_str())
                    });
                }
            }
            ok(&req.id, json!({"panes": panes}))
        }),
        "pane.spawn" => gated(conn, req, "pane.spawn", |conn| {
            match spawn_params(req, conn) {
                Ok(opts) => match mux.lock().expect("mux").spawn(opts) {
                    Ok(spawned) => ok(&req.id, json!(spawned)),
                    Err(err) => err_of(&req.id, &err),
                },
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "pane.send_keys" => gated(conn, req, "pane.send_keys", |_| {
            let pane_id = req
                .params
                .get("paneId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let keys = req.params.get("keys").and_then(Value::as_str).unwrap_or("");
            match mux.lock().expect("mux").send_keys(pane_id, keys) {
                Ok(()) => ok(&req.id, json!({"ok": true})),
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "pane.close" => gated(conn, req, "pane.close", |_| {
            let pane_id = req
                .params
                .get("paneId")
                .and_then(Value::as_str)
                .unwrap_or("");
            match mux.lock().expect("mux").close_pane(pane_id) {
                Ok(()) => ok(&req.id, json!({"ok": true})),
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "pane.read" => gated(conn, req, "pane.read", |conn| {
            let pane_id = req
                .params
                .get("paneId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if let Ok(CallerClass::Pane) = conn.class {
                if conn.env_pane_id.as_deref() != Some(pane_id) {
                    return error(
                        &req.id,
                        "permission_denied",
                        "pane may only read self",
                        "Pass paneId equal to GMUX_PANE_ID",
                    );
                }
            }
            let source = req
                .params
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("");
            let lines = req
                .params
                .get("lines")
                .and_then(Value::as_u64)
                .map(|n| n as usize);
            match mux.lock().expect("mux").read_pane(pane_id, source, lines) {
                Ok(value) => ok(&req.id, value),
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "peel" => handle_peel(mux, hub, conn, req).await,
        "events.subscribe" => gated(conn, req, "events.subscribe", |conn| {
            if conn.subscribed {
                return ok(&req.id, json!({"ok": true}));
            }
            conn.subscribed = true;
            let mut rx = mux.lock().expect("mux").subscribe();
            let writer = writer.clone();
            tokio::spawn(async move {
                while let Ok(event) = rx.recv().await {
                    let msg = json!({"event": event.name, "body": event.body});
                    if write_json(&writer, msg).await.is_err() {
                        break;
                    }
                }
            });
            ok(&req.id, json!({"ok": true}))
        }),
        "tab.close" => gated(conn, req, "tab.close", |_| {
            let tab_id = req
                .params
                .get("tabId")
                .and_then(Value::as_str)
                .unwrap_or("");
            match mux.lock().expect("mux").close_tab(tab_id) {
                Ok(()) => ok(&req.id, json!({"ok": true})),
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "tab.new" => gated(conn, req, "tab.new", |_| {
            let name = req
                .params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tab");
            let workspace_id = req.params.get("workspaceId").and_then(Value::as_str);
            match mux.lock().expect("mux").new_tab(name, workspace_id) {
                Ok(tab_id) => ok(&req.id, json!({ "tabId": tab_id })),
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "tab.rename" => gated(conn, req, "tab.rename", |_| {
            let tab_id = req
                .params
                .get("tabId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let name = req.params.get("name").and_then(Value::as_str).unwrap_or("");
            match mux.lock().expect("mux").rename_tab(tab_id, name) {
                Ok(()) => ok(&req.id, json!({ "ok": true })),
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "pane.move" => gated(conn, req, "pane.move", |_| {
            let src = req
                .params
                .get("srcPane")
                .and_then(Value::as_str)
                .unwrap_or("");
            let dst = req
                .params
                .get("dstTab")
                .and_then(Value::as_str)
                .unwrap_or("");
            match mux.lock().expect("mux").move_pane(src, dst) {
                Ok(()) => ok(&req.id, json!({ "ok": true })),
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "pane.break" => gated(conn, req, "pane.break", |_| {
            let pane = req.params.get("pane").and_then(Value::as_str).unwrap_or("");
            let name = req.params.get("name").and_then(Value::as_str);
            match mux.lock().expect("mux").break_pane(pane, name) {
                Ok(tab_id) => ok(&req.id, json!({ "tabId": tab_id })),
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "prompt.submit" => handle_prompt_submit(mux, hub, conn, req).await,
        "organize.apply" => gated(conn, req, "organize.apply", |_| {
            let plan = req.params.get("plan").cloned().unwrap_or(Value::Null);
            match mux.lock().expect("mux").apply_organize_plan(&plan) {
                Ok(result) => ok(&req.id, result),
                Err(err) => err_of(&req.id, &err),
            }
        }),
        "pane.report_semantics" => gated(conn, req, "pane.report_semantics", |_| {
            let pane_id = req
                .params
                .get("paneId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let state = req
                .params
                .get("state")
                .and_then(Value::as_str)
                .map(str::to_string);
            let semantics = req.params.get("semantics").cloned();
            let resources = req.params.get("resources").cloned();
            let guardian_log = req.params.get("guardianLog").cloned();
            let host_pressure = req.params.get("hostPressure").cloned();
            mux.lock().expect("mux").report_semantics(
                pane_id,
                state,
                semantics,
                resources,
                guardian_log.as_ref(),
                host_pressure,
                json_opt_str(&req.params, "harness"),
                json_opt_str(&req.params, "sessionId"),
            );
            ok(&req.id, json!({"ok": true}))
        }),
        "guardian.broadcast" => gated(conn, req, "guardian.broadcast", |_| {
            let message = req
                .params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("");
            mux.lock().expect("mux").guardian_broadcast(message);
            ok(&req.id, json!({"ok": true}))
        }),
        other => error(
            &req.id,
            "unknown_method",
            &format!("unknown method {other}"),
            "Supported: ping, session.snapshot, pane.list, pane.spawn, pane.send_keys, pane.close, pane.read, tab.new, tab.rename, tab.close, pane.move, pane.break, prompt.submit, organize.apply, peel, events.subscribe, hello, client.attach, client.focus, pane.report_semantics",
        ),
    }
}

fn gated(
    conn: &mut Conn,
    req: &Request,
    method: &str,
    f: impl FnOnce(&mut Conn) -> Value,
) -> Value {
    match &conn.class {
        Err(message) => error(
            &req.id,
            "permission_denied",
            message,
            "A descendant of a pane pid is always pane — unsetting GMUX_PANE_ID is permission_denied, never cli",
        ),
        Ok(class) if !allowed(*class, method) => error(
            &req.id,
            "permission_denied",
            &format!("{class:?} may not call {method}"),
            "Use gmux from a host shell (cli) or the TUI",
        ),
        Ok(_) => f(conn),
    }
}

pub(crate) fn allowed(class: CallerClass, method: &str) -> bool {
    match class {
        CallerClass::Cli | CallerClass::Tui => true,
        CallerClass::Intel => matches!(
            method,
            "hello"
                | "ping"
                | "pane.list"
                | "session.snapshot"
                | "events.subscribe"
                | "pane.read"
                | "pane.report_semantics"
                | "guardian.broadcast"
        ),
        CallerClass::Pane => matches!(
            method,
            "ping"
                | "peel"
                | "pane.list"
                | "session.snapshot"
                | "pane.spawn"
                | "events.subscribe"
                | "pane.read"
        ),
    }
}

async fn handle_hello(
    mux: &Arc<Mutex<Mux>>,
    lock: &Arc<Mutex<Lock>>,
    hub: &Arc<IntelHub>,
    conn: &mut Conn,
    req: &Request,
    writer: &Arc<tokio::sync::Mutex<OwnedWriteHalf>>,
) -> Value {
    let token = req
        .params
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("");
    let hello = {
        let mut guard = mux.lock().expect("mux");
        let caller = conn.class.as_ref().ok().copied();
        match peer::intel_hello(
            token,
            &guard.intel_token,
            conn.peer_pid,
            guard.intel_pid,
            caller,
        ) {
            Ok(pid) => {
                guard.intel_pid = Some(pid);
                guard.intel_connected = true;
                if let Some(argv) = req.params.get("agentHarness").and_then(Value::as_array) {
                    let argv: Vec<String> = argv
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect();
                    if !argv.is_empty() {
                        guard.cached_harness_argv = Some(argv);
                        if guard.status.as_deref() == Some("no agent harness — gmux setup") {
                            guard.status = None;
                        }
                    }
                }
                Ok(pid)
            }
            Err(err) => Err(err),
        }
    };
    match hello {
        Ok(pid) => {
            if let Ok(mut held) = lock.lock() {
                let _ = held.set_intel_pid(Some(pid));
            }
            conn.class = Ok(CallerClass::Intel);
            hub.attach(writer.clone()).await;
            ok(&req.id, json!({"ok": true, "class": "intel"}))
        }
        Err(err) => error(&req.id, "permission_denied", &err.to_string(), err.fix()),
    }
}

async fn handle_peel(
    mux: &Arc<Mutex<Mux>>,
    hub: &Arc<IntelHub>,
    conn: &mut Conn,
    req: &Request,
) -> Value {
    let denied = gated(conn, req, "peel", |_| json!(null));
    if denied.get("error").is_some() {
        return denied;
    }

    let spawned = {
        let mut guard = mux.lock().expect("mux");
        if let Ok(CallerClass::Pane) = conn.class {
            let Some(pane_id) = conn.env_pane_id.clone() else {
                return error(
                    &req.id,
                    "permission_denied",
                    "pane peel requires GMUX_PANE_ID",
                    "A descendant of a pane pid peels from self — unset GMUX_PANE_ID is permission_denied",
                );
            };
            crate::peel::peel_spawn(&mut guard, &pane_id, None)
        } else if let Some(pane_id) = req
            .params
            .get("paneId")
            .and_then(Value::as_str)
            .or_else(|| req.params.get("from").and_then(Value::as_str))
        {
            crate::peel::peel_spawn(&mut guard, pane_id, conn.client_id.as_deref())
        } else if let Ok(CallerClass::Tui) = conn.class {
            let Some(client_id) = conn.client_id.clone().or_else(|| {
                req.params
                    .get("clientId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }) else {
                return error(
                    &req.id,
                    "invalid_request",
                    "peel needs a clientId",
                    "Attach a TUI or pass params.clientId",
                );
            };
            crate::peel::peel_spawn_for_client(&mut guard, &client_id)
        } else {
            let parent = req
                .params
                .get("clientId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| conn.client_id.clone())
                .and_then(|id| guard.focused(&id).map(str::to_string))
                .or_else(|| guard.last_tui_focus());
            let Some(parent) = parent else {
                return error(
                    &req.id,
                    "invalid_request",
                    "peel needs a focused pane",
                    "Attach a TUI or pass --from <paneId>",
                );
            };
            crate::peel::peel_spawn(&mut guard, &parent, conn.client_id.as_deref())
        }
    };

    let PeelSpawn {
        spawned,
        parent_id,
        seed0,
        harness_missing,
    } = match spawned {
        Ok(s) => s,
        Err(err) => return err_of(&req.id, &err),
    };

    let wait_slow = matches!(conn.class, Ok(CallerClass::Cli));
    let child_id = spawned.pane_id.clone();
    let tab_id = spawned.tab_id.clone();
    let extractor0 = crate::peel::shadow_extractor(&seed0);

    // No interactive harness: spawn $SHELL and do not submit into it.
    if harness_missing {
        return ok(
            &req.id,
            json!({
                "paneId": child_id,
                "tabId": tab_id,
                "submitted": false,
                "extractor": extractor0,
            }),
        );
    }

    let mux2 = mux.clone();
    let hub2 = hub.clone();
    if wait_slow {
        let hub_ex = hub2.clone();
        let hub_pk = hub2.clone();
        let slow = crate::peel::peel_slow(
            mux2,
            parent_id,
            child_id.clone(),
            seed0,
            move |grid| {
                let hub = hub_ex.clone();
                async move { hub.extract(grid).await }
            },
            move |params| {
                let hub = hub_pk.clone();
                async move { hub.pack(params).await }
            },
        )
        .await;
        return ok(
            &req.id,
            json!({
                "paneId": child_id,
                "tabId": tab_id,
                "submitted": slow.submitted,
                "extractor": slow.extractor,
            }),
        );
    }

    tokio::spawn(async move {
        let hub_ex = hub2.clone();
        let hub_pk = hub2.clone();
        let _ = crate::peel::peel_slow(
            mux2,
            parent_id,
            child_id,
            seed0,
            move |grid| {
                let hub = hub_ex.clone();
                async move { hub.extract(grid).await }
            },
            move |params| {
                let hub = hub_pk.clone();
                async move { hub.pack(params).await }
            },
        )
        .await;
    });
    ok(
        &req.id,
        json!({
            "paneId": spawned.pane_id,
            "tabId": spawned.tab_id,
            "submitted": false,
            "extractor": extractor0,
        }),
    )
}

async fn handle_attach(mux: &Arc<Mutex<Mux>>, conn: &mut Conn, req: &Request) -> Value {
    let allowed = match &conn.class {
        Ok(class) => peer::may_attach(*class),
        Err(_) => false,
    };
    if !allowed {
        return error(
            &req.id,
            "permission_denied",
            "cannot attach",
            "A descendant of a pane pid is always pane — unsetting GMUX_PANE_ID is permission_denied, never cli",
        );
    }
    let cols = req.params.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
    let rows = req.params.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
    let want_id = req
        .params
        .get("clientId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let cwd = req
        .params
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let client = match mux
        .lock()
        .expect("mux")
        .attach_client(want_id, cols, rows, cwd.as_deref())
    {
        Ok(c) => c,
        Err(err) => return err_of(&req.id, &err),
    };
    let frames_path = mux
        .lock()
        .expect("mux")
        .paths
        .frames_socket_path(&client.id);
    match crate::frames::listen(&frames_path) {
        Ok(listener) => {
            let mux = mux.clone();
            let id = client.id.clone();
            tokio::spawn(async move {
                crate::frames::serve(mux, id, listener).await;
            });
        }
        Err(err) => {
            mux.lock().expect("mux").detach_client(&client.id);
            return error(
                &req.id,
                "io",
                &format!("failed to bind frames socket: {err}"),
                "Check the cache dir is writable",
            );
        }
    }
    conn.client_id = Some(client.id.clone());
    conn.class = Ok(CallerClass::Tui);
    ok(
        &req.id,
        json!({
            "clientId": client.id,
            "focusedPaneId": client.focused_pane_id,
            "cols": client.cols,
            "rows": client.rows,
            "framesSocket": frames_path,
        }),
    )
}

async fn handle_prompt_submit(
    mux: &Arc<Mutex<Mux>>,
    hub: &Arc<IntelHub>,
    conn: &Conn,
    req: &Request,
) -> Value {
    match &conn.class {
        Err(message) => {
            return error(
                &req.id,
                "permission_denied",
                message,
                "A descendant of a pane pid is always pane — unsetting GMUX_PANE_ID is permission_denied, never cli",
            );
        }
        Ok(class) if !allowed(*class, "prompt.submit") => {
            return error(
                &req.id,
                "permission_denied",
                &format!("{class:?} may not call prompt.submit"),
                "Type in the gmux sidebar prompt, or run `gmux organize`",
            );
        }
        Ok(_) => {}
    }
    let prompt = req
        .params
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if prompt.trim().is_empty() {
        return ok(&req.id, json!({ "intent": "ask" }));
    }
    let classified = match hub
        .call(
            "classify.intent",
            json!({ "prompt": prompt }),
            CLASSIFY_TIMEOUT,
        )
        .await
    {
        Ok(v) => v
            .get("intent")
            .and_then(Value::as_str)
            .unwrap_or("ask")
            .to_string(),
        Err(_) => "ask".to_string(), // intel down / timeout → never regroup unattended
    };
    if classified != "organize" {
        return ok(&req.id, json!({ "intent": "ask" }));
    }
    let panes = {
        let guard = mux.lock().expect("mux");
        organize_panes_from_snapshot(&guard.snapshot())
    };
    match hub
        .call(
            "organize.plan",
            json!({ "prompt": prompt, "panes": panes }),
            ORGANIZE_TIMEOUT,
        )
        .await
    {
        Ok(plan) => ok(&req.id, json!({ "intent": "organize", "plan": plan })),
        Err(err) => err_of(&req.id, &err),
    }
}

fn organize_panes_from_snapshot(snap: &Value) -> Vec<Value> {
    snap.get("panes")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|p| {
                    let argv = p.get("argv").and_then(Value::as_array);
                    let command = argv
                        .and_then(|a| a.first())
                        .and_then(Value::as_str)
                        .and_then(|s| std::path::Path::new(s).file_name()?.to_str())
                        .unwrap_or("");
                    json!({
                        "paneId": p.get("paneId"),
                        "tabId": p.get("tabId"),
                        "cwd": p.get("cwd"),
                        "command": command,
                        "harness": p.get("harness"),
                        "state": p.get("state"),
                        "label": p.get("semantics").and_then(|s| s.get("label")),
                        "active": false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn spawn_params(req: &Request, conn: &Conn) -> Result<SpawnOpts, MuxError> {
    let cwd = req
        .params
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));
    let argv = match req.params.get("argv") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    let env = match req.params.get("env") {
        Some(Value::Object(map)) => map
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect(),
        _ => Default::default(),
    };
    let tab = match req.params.get("tab") {
        Some(t) if t.get("mode").and_then(Value::as_str) == Some("existing") => {
            let tab_id = t
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    MuxError::rpc(
                        "invalid_request",
                        "tab.tabId required for existing tab",
                        "Pass tab: { mode: \"existing\", tabId }",
                    )
                })?
                .to_string();
            TabSpec::Existing { tab_id }
        }
        Some(t) => TabSpec::New {
            name: t
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("main")
                .to_string(),
        },
        None => TabSpec::New {
            name: "main".into(),
        },
    };
    Ok(SpawnOpts {
        cwd,
        argv,
        env,
        tab,
        focus: req
            .params
            .get("focus")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        peel_depth: req
            .params
            .get("peelDepth")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        client_id: conn.client_id.clone(),
        workspace_id: None,
        template_id: req
            .params
            .get("templateId")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn pane_workspace(mux: &Mux, pane_id: Option<&str>) -> Option<String> {
    pane_id.and_then(|id| mux.panes.get(id).map(|p| p.workspace_id.clone()))
}

/// Pane callers see only their workspace: workspaces, panes, and clients.
pub fn filter_snapshot_to_workspace(snap: &mut Value, workspace_id: &str) {
    let pane_ids: Vec<String> = snap
        .get("panes")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|p| p.get("workspaceId").and_then(Value::as_str) == Some(workspace_id))
                .filter_map(|p| p.get("paneId").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if let Some(arr) = snap.get_mut("workspaces").and_then(Value::as_array_mut) {
        arr.retain(|w| w.get("id").and_then(Value::as_str) == Some(workspace_id));
    }
    if let Some(arr) = snap.get_mut("panes").and_then(Value::as_array_mut) {
        arr.retain(|p| p.get("workspaceId").and_then(Value::as_str) == Some(workspace_id));
    }
    if let Some(arr) = snap.get_mut("clients").and_then(Value::as_array_mut) {
        arr.retain(|c| {
            c.get("focusedPaneId")
                .and_then(Value::as_str)
                .is_some_and(|id| pane_ids.iter().any(|p| p == id))
        });
    }
}

fn json_opt_str(params: &Value, key: &str) -> Option<Option<String>> {
    match params.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if s.is_empty() => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        Some(_) => None,
    }
}

fn ok(id: &Value, result: Value) -> Value {
    json!({"id": id, "result": result})
}

fn error(id: &Value, code: &str, message: &str, fix: &str) -> Value {
    json!({"id": id, "error": {"code": code, "message": message, "fix": fix}})
}

fn err_of(id: &Value, err: &MuxError) -> Value {
    error(id, err.code(), &err.message(), err.fix())
}

async fn write_json(
    writer: &Arc<tokio::sync::Mutex<OwnedWriteHalf>>,
    value: Value,
) -> std::io::Result<()> {
    let mut line = value.to_string();
    line.push('\n');
    let mut w = writer.lock().await;
    w.write_all(line.as_bytes()).await?;
    w.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peer::CallerClass;

    #[test]
    fn intel_may_not_send_keys() {
        assert!(!allowed(CallerClass::Intel, "pane.send_keys"));
        assert!(!allowed(CallerClass::Intel, "prompt.submit"));
        assert!(!allowed(CallerClass::Intel, "organize.apply"));
        assert!(!allowed(CallerClass::Intel, "tab.new"));
        assert!(allowed(CallerClass::Intel, "guardian.broadcast"));
        assert!(allowed(CallerClass::Intel, "pane.report_semantics"));
        assert!(allowed(CallerClass::Cli, "pane.send_keys"));
        assert!(allowed(CallerClass::Cli, "prompt.submit"));
        assert!(allowed(CallerClass::Tui, "organize.apply"));
        assert!(allowed(CallerClass::Tui, "tab.new"));
        assert!(allowed(CallerClass::Tui, "pane.send_keys"));
    }

    #[test]
    fn intel_error_reply_is_err_not_ok() {
        let reply = json!({
            "id": "ex_1",
            "error": {"code": "timeout", "message": "hung", "fix": "retry"}
        });
        let err = intel_reply_result(&reply).unwrap_err();
        assert_eq!(err.code(), "timeout");
        assert!(err.message().contains("hung"));
        assert_eq!(err.fix(), "retry");
    }

    #[test]
    fn intel_result_reply_returns_result_only() {
        let reply = json!({"id": "ex_1", "result": {"text": "hi"}});
        let value = intel_reply_result(&reply).unwrap();
        assert_eq!(value, json!({"text": "hi"}));
    }

    #[test]
    fn find_gmux_uses_path_when_gmux_path_unset() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("gmux");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let found = find_gmux_from(None, Some(dir.path().to_str().unwrap()));
        assert_eq!(found.as_deref(), Some(bin.as_path()));
    }

    #[test]
    fn find_gmux_prefers_gmux_path_file() {
        let dir = tempfile::tempdir().unwrap();
        let on_path = dir.path().join("gmux");
        std::fs::write(&on_path, "path").unwrap();
        let explicit = dir.path().join("explicit-gmux");
        std::fs::write(&explicit, "explicit").unwrap();
        let found = find_gmux_from(
            Some(explicit.to_str().unwrap()),
            Some(dir.path().to_str().unwrap()),
        );
        assert_eq!(found.as_deref(), Some(explicit.as_path()));
    }

    #[tokio::test]
    async fn sidecar_spawn_sees_token_and_socket() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::from_dir(dir.path());
        let (_token, _listener) = prepare_listener(&paths).unwrap();
        assert!(paths.intel_token_path().is_file());
        assert!(paths.socket_path().exists());

        let marker = dir.path().join("spawned");
        let script = dir.path().join("gmux");
        let sock = paths.socket_path();
        let token = paths.intel_token_path();
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nif [ -e {sock:?} ] && [ -e {token:?} ]; then echo ok > {marker:?}; fi\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        spawn_sidecar_bin(&script);

        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1000);
        while std::time::Instant::now() < deadline {
            if marker.is_file() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            marker.is_file(),
            "sidecar spawn must observe mux.sock and intel.token"
        );
    }
}
