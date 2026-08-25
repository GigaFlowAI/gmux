//! NDJSON control socket on `mux.sock` (mode 0o600).
//!
//! Request: `{"id","method","params"}`.
//! Reply: `{"id","result"}` or `{"id","error":{"code","message","fix"}}`.
//! Events: `{"event":"pane.created","body":{...}}`.
//! Intel is a bidirectional stub this task: accept `hello`, ignore other inbound
//! requests (full RPC lands Task 5).

use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::net::unix::OwnedWriteHalf;

use crate::lock::Lock;
use crate::paths::Paths;
use crate::peer::{self, CallerClass};
use crate::session::{Mux, MuxError, SpawnOpts, TabSpec};

pub async fn run(paths: Paths, lock: Lock) -> std::io::Result<()> {
    let token = mint_token(&paths)?;
    let sock = paths.socket_path();
    if sock.exists() {
        let _ = std::fs::remove_file(&sock);
    }
    paths.ensure_dir()?;

    let listener = UnixListener::bind(&sock)?;
    std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))?;

    let mux = Arc::new(Mutex::new(Mux::new(paths.clone(), token)));
    let lock = Arc::new(Mutex::new(lock));

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let mux = mux.clone();
                let lock = lock.clone();
                tokio::spawn(async move {
                    if let Err(err) = handle_client(mux, lock, stream).await {
                        eprintln!("gmuxd client: {err}");
                    }
                });
            }
            _ = shutdown_signal() => break,
        }
    }

    let _ = std::fs::remove_file(&sock);
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

        if matches!(conn.class, Ok(CallerClass::Intel)) && req.method != "hello" {
            continue;
        }

        let reply = dispatch(&mux, &lock, &mut conn, &req, &writer).await;
        write_json(&writer, reply).await?;
    }
    Ok(())
}

async fn dispatch(
    mux: &Arc<Mutex<Mux>>,
    lock: &Arc<Mutex<Lock>>,
    conn: &mut Conn,
    req: &Request,
    writer: &Arc<tokio::sync::Mutex<OwnedWriteHalf>>,
) -> Value {
    match req.method.as_str() {
        "hello" => handle_hello(mux, lock, conn, req),
        "ping" => ok(&req.id, json!({"ok": true})),
        "client.attach" => handle_attach(mux, conn, req),
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
        "peel" => gated(conn, req, "peel", |conn| {
            let mut guard = mux.lock().expect("mux");
            let result = if let Ok(CallerClass::Pane) = conn.class {
                let Some(pane_id) = conn.env_pane_id.as_deref() else {
                    return error(
                        &req.id,
                        "permission_denied",
                        "pane peel requires GMUX_PANE_ID",
                        "A descendant of a pane pid peels from self — unset GMUX_PANE_ID is permission_denied",
                    );
                };
                crate::peel::peel_from_pane(&mut guard, pane_id, None)
            } else {
                let client_id = req
                    .params
                    .get("clientId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| conn.client_id.clone());
                let Some(client_id) = client_id else {
                    return error(
                        &req.id,
                        "invalid_request",
                        "peel needs a clientId",
                        "Attach a TUI or pass params.clientId",
                    );
                };
                crate::peel::peel(&mut guard, &client_id)
            };
            match result {
                Ok(spawned) => ok(&req.id, json!(spawned)),
                Err(err) => err_of(&req.id, &err),
            }
        }),
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
        other => error(
            &req.id,
            "unknown_method",
            &format!("unknown method {other}"),
            "Supported: ping, session.snapshot, pane.list, pane.spawn, pane.send_keys, pane.close, peel, events.subscribe, hello, client.attach",
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

fn allowed(class: CallerClass, method: &str) -> bool {
    match class {
        CallerClass::Cli | CallerClass::Tui => true,
        CallerClass::Intel => matches!(
            method,
            "hello" | "ping" | "pane.list" | "session.snapshot" | "events.subscribe"
        ),
        CallerClass::Pane => matches!(
            method,
            "ping" | "peel" | "pane.list" | "session.snapshot" | "pane.spawn" | "events.subscribe"
        ),
    }
}

fn handle_hello(
    mux: &Arc<Mutex<Mux>>,
    lock: &Arc<Mutex<Lock>>,
    conn: &mut Conn,
    req: &Request,
) -> Value {
    let token = req
        .params
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("");
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
            drop(guard);
            if let Ok(mut held) = lock.lock() {
                let _ = held.set_intel_pid(Some(pid));
            }
            conn.class = Ok(CallerClass::Intel);
            ok(&req.id, json!({"ok": true, "class": "intel"}))
        }
        Err(err) => error(&req.id, "permission_denied", &err.to_string(), err.fix()),
    }
}

fn handle_attach(mux: &Arc<Mutex<Mux>>, conn: &mut Conn, req: &Request) -> Value {
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
    let client = mux.lock().expect("mux").attach_client(want_id, cols, rows);
    conn.client_id = Some(client.id.clone());
    conn.class = Ok(CallerClass::Tui);
    ok(
        &req.id,
        json!({
            "clientId": client.id,
            "focusedPaneId": client.focused_pane_id,
            "cols": client.cols,
            "rows": client.rows,
        }),
    )
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
