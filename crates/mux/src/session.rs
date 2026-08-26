//! Session tree: workspaces → tabs → panes. Focus is per-client. No global focused pane.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::sync::broadcast;

use crate::grid::GridSnapshot;
use crate::pane::{Pane, SpawnPty, new_id, new_ulid};
use crate::paths::Paths;
use crate::peer::{PidTree, tree_pids};

#[derive(Debug, thiserror::Error)]
pub enum MuxError {
    #[error("{message}")]
    Rpc {
        code: String,
        message: String,
        fix: String,
    },
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl MuxError {
    pub fn rpc(code: &str, message: &str, fix: &str) -> Self {
        Self::Rpc {
            code: code.into(),
            message: message.into(),
            fix: fix.into(),
        }
    }

    pub fn code(&self) -> &str {
        match self {
            Self::Rpc { code, .. } => code,
            Self::Io(_) => "io",
        }
    }

    pub fn message(&self) -> String {
        self.to_string()
    }

    pub fn fix(&self) -> &str {
        match self {
            Self::Rpc { fix, .. } => fix,
            Self::Io(_) => "Check mux.sock and retry",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Spawned {
    #[serde(rename = "paneId")]
    pub pane_id: String,
    #[serde(rename = "tabId")]
    pub tab_id: String,
}

#[derive(Debug, Clone)]
pub enum TabSpec {
    New { name: String },
    Existing { tab_id: String },
}

#[derive(Debug, Clone)]
pub struct SpawnOpts {
    pub cwd: PathBuf,
    pub argv: Vec<String>,
    pub env: HashMap<String, String>,
    pub tab: TabSpec,
    pub focus: bool,
    pub peel_depth: u32,
    pub client_id: Option<String>,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Client {
    pub id: String,
    pub focused_pane_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone)]
pub struct Tab {
    pub id: String,
    pub name: String,
    pub pane_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub id: String,
    pub cwd: PathBuf,
    pub tabs: HashMap<String, Tab>,
}

#[derive(Clone, Debug)]
pub struct Event {
    pub name: String,
    pub body: serde_json::Value,
}

/// Same window as `src/core/pane-state.ts` `WORKING_WINDOW_MS`.
pub const WORKING_WINDOW_MS: u64 = 10_000;

#[derive(Clone, Debug, Default)]
pub struct IntelPatch {
    pub state: Option<String>,
    pub semantics: Option<serde_json::Value>,
    pub resources: Option<serde_json::Value>,
}

pub struct Mux {
    pub paths: Paths,
    pub intel_token: String,
    pub intel_pid: Option<u32>,
    pub intel_connected: bool,
    pub cached_harness_argv: Option<Vec<String>>,
    pub workspaces: HashMap<String, Workspace>,
    pub panes: HashMap<String, Pane>,
    pub clients: HashMap<String, Client>,
    pub patches: HashMap<String, IntelPatch>,
    pub guardian_log: Vec<serde_json::Value>,
    pub host_pressure: Option<serde_json::Value>,
    event_tx: broadcast::Sender<Event>,
}

impl Mux {
    pub fn new(paths: Paths, intel_token: String) -> Self {
        let (event_tx, _) = broadcast::channel(64);
        Self {
            paths,
            intel_token,
            intel_pid: None,
            intel_connected: false,
            cached_harness_argv: None,
            workspaces: HashMap::new(),
            panes: HashMap::new(),
            clients: HashMap::new(),
            patches: HashMap::new(),
            guardian_log: Vec::new(),
            host_pressure: None,
            event_tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.event_tx.subscribe()
    }

    pub fn emit(&self, name: &str, body: serde_json::Value) {
        let _ = self.event_tx.send(Event {
            name: name.into(),
            body,
        });
    }

    pub fn default_argv(&self) -> Vec<String> {
        if let Some(argv) = &self.cached_harness_argv {
            return argv.clone();
        }
        vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())]
    }

    pub fn set_client_focus(&mut self, client_id: &str, pane_id: &str) {
        let client = self
            .clients
            .entry(client_id.to_string())
            .or_insert_with(|| Client {
                id: client_id.to_string(),
                focused_pane_id: None,
                cols: 80,
                rows: 24,
            });
        client.focused_pane_id = Some(pane_id.to_string());
    }

    pub fn focused(&self, client_id: &str) -> Option<&str> {
        self.clients
            .get(client_id)
            .and_then(|c| c.focused_pane_id.as_deref())
    }

    pub fn write_input(&mut self, pane_id: &str, bytes: &[u8]) -> Result<(), MuxError> {
        let pane = self.panes.get_mut(pane_id).ok_or_else(|| {
            MuxError::rpc(
                "not_found",
                &format!("pane {pane_id} not found"),
                "Run gmux panes ls --json",
            )
        })?;
        pane.write_input(bytes)
    }

    pub fn send_keys(&mut self, pane_id: &str, keys: &str) -> Result<(), MuxError> {
        self.write_input(pane_id, keys.as_bytes())
    }

    /// Intel guardian broadcast: send_keys to panes with `harness != null` only.
    pub fn guardian_broadcast(&mut self, message: &str) -> Vec<String> {
        let ids: Vec<String> = self
            .panes
            .values()
            .filter(|p| p.harness.is_some())
            .map(|p| p.id.clone())
            .collect();
        for id in &ids {
            let _ = self.send_keys(id, message);
        }
        ids
    }

    pub fn read_grid(&self, pane_id: &str, rows: Option<usize>) -> Result<GridSnapshot, MuxError> {
        let pane = self
            .panes
            .get(pane_id)
            .ok_or_else(|| pane_missing(pane_id))?;
        let grid = pane.grid.lock().expect("grid");
        Ok(grid.snapshot_rows(&pane.id, &foreground_command(&pane.argv), rows))
    }

    pub fn read_lines(&self, pane_id: &str, n: Option<usize>) -> Result<String, MuxError> {
        let pane = self
            .panes
            .get(pane_id)
            .ok_or_else(|| pane_missing(pane_id))?;
        let grid = pane.grid.lock().expect("grid");
        Ok(grid.read_lines(n))
    }

    pub fn read_pane(
        &self,
        pane_id: &str,
        source: &str,
        lines: Option<usize>,
    ) -> Result<serde_json::Value, MuxError> {
        match source {
            "grid" => {
                let snap = self.read_grid(pane_id, lines)?;
                Ok(serde_json::to_value(snap).expect("GridSnapshot"))
            }
            "lines" => {
                let text = self.read_lines(pane_id, lines)?;
                Ok(serde_json::json!({ "text": text }))
            }
            other => Err(MuxError::rpc(
                "invalid_request",
                &format!("unknown pane.read source {other}"),
                "Pass source: \"grid\" or source: \"lines\"",
            )),
        }
    }

    pub fn spawn(&mut self, opts: SpawnOpts) -> Result<Spawned, MuxError> {
        let cwd = if opts.cwd.as_os_str().is_empty() {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
        } else {
            opts.cwd.clone()
        };
        let workspace_id = match opts.workspace_id.clone() {
            Some(id) if self.workspaces.contains_key(&id) => id,
            _ => self.ensure_workspace(&cwd),
        };

        let (tab_id, tab_name) = match &opts.tab {
            TabSpec::Existing { tab_id } => {
                let ws = self.workspaces.get(&workspace_id).ok_or_else(|| {
                    MuxError::rpc(
                        "not_found",
                        "workspace not found",
                        "Run gmux snapshot --json",
                    )
                })?;
                if !ws.tabs.contains_key(tab_id) {
                    return Err(MuxError::rpc(
                        "not_found",
                        &format!("tab {tab_id} not found"),
                        "Run gmux snapshot --json",
                    ));
                }
                let name = ws.tabs[tab_id].name.clone();
                (tab_id.clone(), name)
            }
            TabSpec::New { name } => (new_id("t_"), name.clone()),
        };

        let (pane_id, pane_bytes) = new_ulid("p_");
        let mut env = opts.env.clone();
        env.insert(
            "GMUX_SOCKET_PATH".into(),
            self.paths.socket_path().to_string_lossy().into_owned(),
        );
        env.insert("GMUX_PANE_ID".into(), pane_id.clone());
        env.insert("GMUX_TAB_ID".into(), tab_id.clone());
        env.insert("GMUX_WORKSPACE_ID".into(), workspace_id.clone());
        env.insert("GMUX_CHILD".into(), "1".into());
        env.insert("GMUX_PEEL_DEPTH".into(), opts.peel_depth.to_string());

        let argv = if opts.argv.is_empty() {
            self.default_argv()
        } else {
            opts.argv.clone()
        };

        let (cols, rows) = opts
            .client_id
            .as_deref()
            .and_then(|id| self.clients.get(id))
            .map(|c| (c.cols, c.rows))
            .unwrap_or((80, 24));

        let pane = Pane::spawn(
            pane_id.clone(),
            pane_bytes,
            tab_id.clone(),
            workspace_id.clone(),
            opts.peel_depth,
            SpawnPty {
                cwd: cwd.clone(),
                argv,
                env,
                cols,
                rows,
            },
        )?;

        {
            let ws = self
                .workspaces
                .entry(workspace_id.clone())
                .or_insert_with(|| Workspace {
                    id: workspace_id.clone(),
                    cwd: cwd.clone(),
                    tabs: HashMap::new(),
                });
            let tab = ws.tabs.entry(tab_id.clone()).or_insert_with(|| Tab {
                id: tab_id.clone(),
                name: tab_name,
                pane_ids: Vec::new(),
            });
            tab.pane_ids.push(pane_id.clone());
        }

        if opts.focus {
            if let Some(client_id) = &opts.client_id {
                self.set_client_focus(client_id, &pane_id);
            }
        }

        self.emit(
            "pane.created",
            serde_json::json!({
                "paneId": pane_id,
                "tabId": tab_id,
                "workspaceId": workspace_id,
                "pid": pane.pid,
                "cwd": pane.cwd,
                "argv": pane.argv,
                "peelDepth": pane.peel_depth,
            }),
        );

        self.panes.insert(pane_id.clone(), pane);
        Ok(Spawned { pane_id, tab_id })
    }

    pub fn close_pane(&mut self, pane_id: &str) -> Result<(), MuxError> {
        let mut pane = self.panes.remove(pane_id).ok_or_else(|| {
            MuxError::rpc(
                "not_found",
                &format!("pane {pane_id} not found"),
                "Run gmux panes ls --json",
            )
        })?;
        let tab_id = pane.tab_id.clone();
        let workspace_id = pane.workspace_id.clone();
        pane.kill();
        self.patches.remove(pane_id);

        if let Some(ws) = self.workspaces.get_mut(&workspace_id) {
            if let Some(tab) = ws.tabs.get_mut(&tab_id) {
                tab.pane_ids.retain(|id| id != pane_id);
                if tab.pane_ids.is_empty() {
                    ws.tabs.remove(&tab_id);
                }
            }
        }
        for client in self.clients.values_mut() {
            if client.focused_pane_id.as_deref() == Some(pane_id) {
                client.focused_pane_id = None;
            }
        }
        self.emit(
            "pane.exited",
            serde_json::json!({ "paneId": pane_id, "tabId": tab_id }),
        );
        Ok(())
    }

    pub fn attach_client(
        &mut self,
        client_id: Option<String>,
        cols: u16,
        rows: u16,
        cwd: Option<&Path>,
    ) -> Result<Client, MuxError> {
        let cols = if cols == 0 { 80 } else { cols };
        let rows = if rows == 0 { 24 } else { rows };
        let id = client_id.unwrap_or_else(|| new_id("c_"));
        let focused = self
            .clients
            .get(&id)
            .and_then(|c| c.focused_pane_id.clone());
        let client = Client {
            id: id.clone(),
            focused_pane_id: focused,
            cols,
            rows,
        };
        self.clients.insert(id.clone(), client);
        let cwd = cwd
            .map(Path::to_path_buf)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));
        self.bootstrap_if_empty(&id, &cwd)?;
        Ok(self.clients.get(&id).cloned().expect("client"))
    }

    /// Detach this TUI. Does not SIGHUP panes.
    pub fn detach_client(&mut self, client_id: &str) {
        self.clients.remove(client_id);
        let path = self.paths.frames_socket_path(client_id);
        let _ = std::fs::remove_file(path);
    }

    pub fn client_input(&mut self, client_id: &str, bytes: &[u8]) -> Result<(), MuxError> {
        let pane_id = self
            .focused(client_id)
            .ok_or_else(|| {
                MuxError::rpc(
                    "not_found",
                    "no focused pane for this client",
                    "Attach a TUI or spawn a pane with focus: true",
                )
            })?
            .to_string();
        self.write_input(&pane_id, bytes)
    }

    pub fn resize_client(&mut self, client_id: &str, cols: u16, rows: u16) -> Result<(), MuxError> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let pane_id = {
            let client = self.clients.get_mut(client_id).ok_or_else(|| {
                MuxError::rpc(
                    "not_found",
                    &format!("client {client_id} not found"),
                    "Call client.attach first",
                )
            })?;
            client.cols = cols;
            client.rows = rows;
            client.focused_pane_id.clone()
        };
        if let Some(pane_id) = pane_id {
            if let Some(pane) = self.panes.get_mut(&pane_id) {
                pane.resize(cols, rows)?;
            }
        }
        Ok(())
    }

    fn bootstrap_if_empty(&mut self, client_id: &str, cwd: &Path) -> Result<(), MuxError> {
        let workspace_id = self.ensure_workspace(cwd);
        let tab_id = self
            .workspaces
            .get(&workspace_id)
            .and_then(|ws| ws.tabs.values().find(|t| t.name == "main"))
            .map(|t| t.id.clone());
        let tab_id = match tab_id {
            Some(id) => id,
            None => {
                let tab_id = new_id("t_");
                if let Some(ws) = self.workspaces.get_mut(&workspace_id) {
                    ws.tabs.insert(
                        tab_id.clone(),
                        Tab {
                            id: tab_id.clone(),
                            name: "main".into(),
                            pane_ids: Vec::new(),
                        },
                    );
                }
                tab_id
            }
        };
        let first_pane = self
            .workspaces
            .get(&workspace_id)
            .and_then(|ws| ws.tabs.get(&tab_id))
            .and_then(|t| t.pane_ids.first())
            .cloned();
        if first_pane.is_none() {
            let root = self
                .workspaces
                .get(&workspace_id)
                .map(|ws| ws.cwd.clone())
                .unwrap_or_else(|| git_root_or_cwd(cwd));
            self.spawn(SpawnOpts {
                cwd: root,
                argv: self.default_argv(),
                env: Default::default(),
                tab: TabSpec::Existing {
                    tab_id: tab_id.clone(),
                },
                focus: true,
                peel_depth: 0,
                client_id: Some(client_id.to_string()),
                workspace_id: Some(workspace_id),
            })?;
        } else if self.focused(client_id).is_none() {
            if let Some(pane_id) = first_pane {
                self.set_client_focus(client_id, &pane_id);
            }
        }
        Ok(())
    }

    pub fn pane_trees(&self) -> Vec<PidTree> {
        self.panes
            .values()
            .map(|p| PidTree {
                pane_id: p.id.clone(),
                pids: tree_pids(p.pid),
            })
            .collect()
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let now = crate::grid::unix_ms();
        let workspaces: Vec<_> = self
            .workspaces
            .values()
            .map(|ws| {
                let tabs: Vec<_> = ws
                    .tabs
                    .values()
                    .map(|t| {
                        serde_json::json!({
                            "id": t.id,
                            "name": t.name,
                            "paneIds": t.pane_ids,
                        })
                    })
                    .collect();
                serde_json::json!({
                    "id": ws.id,
                    "cwd": ws.cwd,
                    "tabs": tabs,
                })
            })
            .collect();
        let panes: Vec<_> = self
            .panes
            .values()
            .map(|p| self.pane_snapshot(p, now))
            .collect();
        let clients: Vec<_> = self
            .clients
            .values()
            .map(|c| {
                serde_json::json!({
                    "id": c.id,
                    "focusedPaneId": c.focused_pane_id,
                    "cols": c.cols,
                    "rows": c.rows,
                })
            })
            .collect();
        serde_json::json!({
            "workspaces": workspaces,
            "panes": panes,
            "clients": clients,
            "intel": {
                "up": self.intel_connected,
                "pid": self.intel_pid,
            },
            "guardianLog": self.guardian_log,
            "hostPressure": self.host_pressure,
        })
    }

    pub fn list_panes(&self) -> Vec<serde_json::Value> {
        let now = crate::grid::unix_ms();
        self.panes
            .values()
            .map(|p| self.pane_snapshot(p, now))
            .collect()
    }

    /// Intel patches `state` / `semantics` / `resources` / `guardianLog` by paneId.
    /// Layout and identity stay mux-owned. Unknown paneIds are ignored (pane vanished).
    pub fn report_semantics(
        &mut self,
        pane_id: &str,
        state: Option<String>,
        semantics: Option<serde_json::Value>,
        resources: Option<serde_json::Value>,
        guardian_log: Option<&serde_json::Value>,
        host_pressure: Option<serde_json::Value>,
    ) {
        if self.panes.contains_key(pane_id) {
            let entry = self.patches.entry(pane_id.to_string()).or_default();
            if state.is_some() {
                entry.state = state;
            }
            if semantics.is_some() {
                entry.semantics = semantics;
            }
            if resources.is_some() {
                entry.resources = resources;
            }
        }
        if let Some(log) = guardian_log {
            if let Some(arr) = log.as_array() {
                // Full snapshot from intel replaces, so a tick does not append dupes.
                self.guardian_log = arr.clone();
                if self.guardian_log.len() > 50 {
                    let extra = self.guardian_log.len() - 50;
                    self.guardian_log.drain(0..extra);
                }
            } else if log.is_object() {
                self.guardian_log.push(log.clone());
                if self.guardian_log.len() > 50 {
                    self.guardian_log.remove(0);
                }
            }
        }
        if let Some(hp) = host_pressure {
            self.host_pressure = Some(hp);
        }
    }

    pub fn close_tab(&mut self, tab_id: &str) -> Result<(), MuxError> {
        let pane_ids: Vec<String> = self
            .workspaces
            .values()
            .find_map(|ws| ws.tabs.get(tab_id).map(|t| t.pane_ids.clone()))
            .ok_or_else(|| {
                MuxError::rpc(
                    "not_found",
                    &format!("tab {tab_id} not found"),
                    "Run gmux snapshot --json",
                )
            })?;
        for id in pane_ids {
            let _ = self.close_pane(&id);
        }
        for ws in self.workspaces.values_mut() {
            ws.tabs.remove(tab_id);
        }
        Ok(())
    }

    fn pane_snapshot(&self, pane: &Pane, now: u64) -> serde_json::Value {
        let patch = self.patches.get(&pane.id);
        let mut value = pane_json(pane);
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "state".into(),
                serde_json::Value::String(glyph_state(pane, patch, self.intel_connected, now)),
            );
            obj.insert(
                "semantics".into(),
                patch
                    .and_then(|p| p.semantics.clone())
                    .unwrap_or(serde_json::Value::Null),
            );
            obj.insert(
                "resources".into(),
                patch
                    .and_then(|p| p.resources.clone())
                    .unwrap_or(serde_json::Value::Null),
            );
        }
        value
    }

    fn ensure_workspace(&mut self, cwd: &Path) -> String {
        let root = git_root_or_cwd(cwd);
        if let Some((id, _)) = self.workspaces.iter().find(|(_, ws)| ws.cwd == root) {
            return id.clone();
        }
        let id = workspace_id_for(&root);
        if self.workspaces.contains_key(&id) {
            return id;
        }
        self.workspaces.insert(
            id.clone(),
            Workspace {
                id: id.clone(),
                cwd: root,
                tabs: HashMap::new(),
            },
        );
        id
    }
}

impl Drop for Mux {
    fn drop(&mut self) {
        for pane in self.panes.values_mut() {
            pane.kill();
        }
    }
}

fn pane_missing(pane_id: &str) -> MuxError {
    MuxError::rpc(
        "not_found",
        &format!("pane {pane_id} not found"),
        "Run gmux panes ls --json",
    )
}

fn foreground_command(argv: &[String]) -> String {
    argv.first()
        .map(|cmd| {
            std::path::Path::new(cmd)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(cmd)
                .to_string()
        })
        .unwrap_or_default()
}

fn pane_json(pane: &Pane) -> serde_json::Value {
    serde_json::json!({
        "paneId": pane.id,
        "tabId": pane.tab_id,
        "workspaceId": pane.workspace_id,
        "cwd": pane.cwd,
        "argv": pane.argv,
        "pid": pane.pid,
        "harness": pane.harness,
        "sessionId": pane.session_id,
        "peelDepth": pane.peel_depth,
        "templateId": pane.template_id,
    })
}

/// Mux-only glyphs when intel is down: `{working, idle}` from PTY byte activity.
/// `waiting` / `error` / `done` freeze last known.
fn glyph_state(pane: &Pane, patch: Option<&IntelPatch>, intel_up: bool, now: u64) -> String {
    let last = patch.and_then(|p| p.state.as_deref());
    if !intel_up {
        if matches!(last, Some("waiting" | "error" | "done")) {
            return last.unwrap().to_string();
        }
        return pty_glyph(pane, now);
    }
    last.map(str::to_string).unwrap_or_else(|| pty_glyph(pane, now))
}

fn pty_glyph(pane: &Pane, now: u64) -> String {
    let last = pane
        .grid
        .lock()
        .ok()
        .map(|g| g.last_byte_ms)
        .unwrap_or(0);
    if now.saturating_sub(last) < WORKING_WINDOW_MS {
        "working".into()
    } else {
        "idle".into()
    }
}

/// Git toplevel if `git rev-parse --show-toplevel` succeeds, else `cwd`.
pub fn git_root_or_cwd(cwd: &Path) -> PathBuf {
    match std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
    {
        Ok(out) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() {
                cwd.to_path_buf()
            } else {
                PathBuf::from(s)
            }
        }
        _ => cwd.to_path_buf(),
    }
}

/// `ws_` + 12-char hex of SHA-256(git root if git, else cwd).
pub fn workspace_id_for(cwd: &Path) -> String {
    use sha2::{Digest, Sha256};
    use std::os::unix::ffi::OsStrExt;
    let root = git_root_or_cwd(cwd);
    let hash = Sha256::digest(root.as_os_str().as_bytes());
    format!(
        "ws_{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        hash[0], hash[1], hash[2], hash[3], hash[4], hash[5]
    )
}
