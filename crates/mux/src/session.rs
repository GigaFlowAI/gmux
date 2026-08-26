//! Session tree: workspaces → tabs → panes. Focus is per-client. No global focused pane.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::sync::broadcast;

use crate::grid::GridSnapshot;
use crate::pane::{Pane, SpawnPty, new_id};
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

pub struct Mux {
    pub paths: Paths,
    pub intel_token: String,
    pub intel_pid: Option<u32>,
    pub cached_harness_argv: Option<Vec<String>>,
    pub workspaces: HashMap<String, Workspace>,
    pub panes: HashMap<String, Pane>,
    pub clients: HashMap<String, Client>,
    event_tx: broadcast::Sender<Event>,
}

impl Mux {
    pub fn new(paths: Paths, intel_token: String) -> Self {
        let (event_tx, _) = broadcast::channel(64);
        Self {
            paths,
            intel_token,
            intel_pid: None,
            cached_harness_argv: None,
            workspaces: HashMap::new(),
            panes: HashMap::new(),
            clients: HashMap::new(),
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

        let pane_id = new_id("p_");
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

    pub fn attach_client(&mut self, client_id: Option<String>, cols: u16, rows: u16) -> Client {
        let id = client_id.unwrap_or_else(|| new_id("c_"));
        let focused = self
            .clients
            .get(&id)
            .and_then(|c| c.focused_pane_id.clone());
        let client = Client {
            id: id.clone(),
            focused_pane_id: focused,
            cols: if cols == 0 { 80 } else { cols },
            rows: if rows == 0 { 24 } else { rows },
        };
        self.clients.insert(id, client.clone());
        client
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
        let panes: Vec<_> = self.panes.values().map(pane_json).collect();
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
        })
    }

    pub fn list_panes(&self) -> Vec<serde_json::Value> {
        self.panes.values().map(pane_json).collect()
    }

    fn ensure_workspace(&mut self, cwd: &Path) -> String {
        if let Some((id, _)) = self.workspaces.iter().find(|(_, ws)| ws.cwd == cwd) {
            return id.clone();
        }
        let id = workspace_id(cwd);
        self.workspaces.insert(
            id.clone(),
            Workspace {
                id: id.clone(),
                cwd: cwd.to_path_buf(),
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

fn workspace_id(cwd: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    cwd.hash(&mut hasher);
    format!("ws_{:012x}", hasher.finish() & 0xffff_ffff_ffff)
}
