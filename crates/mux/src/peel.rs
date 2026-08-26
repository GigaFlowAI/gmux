//! Mux-local peel: fast spawn from shadow, then slow extract/clear/submit.
//!
//! Fast path must not await intel. Clear then submit, never the reverse.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::grid::GridSnapshot;
use crate::session::{Mux, MuxError, SpawnOpts, Spawned, TabSpec};

const SECONDARY_CLEAR: &str = "\x01\x0b";
const HARNESS_READY: Duration = Duration::from_secs(8);

#[derive(Debug, Clone)]
pub struct PeelSpawn {
    pub spawned: Spawned,
    pub parent_id: String,
    pub seed0: String,
    pub harness_missing: bool,
}

#[derive(Debug, Clone)]
pub struct PeelSlowResult {
    pub submitted: bool,
    pub extractor: String,
}

#[derive(Debug, Clone)]
pub struct ExtractReply {
    pub text: String,
    pub confidence: String,
    pub clear_keys: String,
    pub extractor: String,
}

impl ExtractReply {
    pub fn from_value(v: &Value) -> Option<Self> {
        let text = v.get("text")?.as_str()?.to_string();
        let extractor = v
            .get("extractor")
            .and_then(Value::as_str)
            .unwrap_or("empty")
            .to_string();
        let clear_keys = v
            .get("clearKeys")
            .and_then(Value::as_str)
            .unwrap_or("\u{15}")
            .to_string();
        let confidence = v
            .get("confidence")
            .and_then(Value::as_str)
            .unwrap_or("low")
            .to_string();
        Some(Self {
            text,
            confidence,
            clear_keys,
            extractor,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractError {
    Down,
    Timeout,
    Malformed,
}

/// Fast path for a TUI/cli client: peel **this client's** focused pane.
pub fn peel(mux: &mut Mux, client_id: &str) -> Result<Spawned, MuxError> {
    Ok(peel_spawn_for_client(mux, client_id)?.spawned)
}

pub fn peel_spawn_for_client(mux: &mut Mux, client_id: &str) -> Result<PeelSpawn, MuxError> {
    let parent_id = mux.focused(client_id).map(str::to_string).ok_or_else(|| {
        MuxError::rpc(
            "not_found",
            "no focused pane for this client",
            "Focus a pane or pass --from <paneId>",
        )
    })?;
    peel_spawn(mux, &parent_id, Some(client_id))
}

/// Fast path for a pane caller: peel **from self**. `focus: false`.
pub fn peel_from_pane(
    mux: &mut Mux,
    parent_id: &str,
    client_id: Option<&str>,
) -> Result<Spawned, MuxError> {
    Ok(peel_spawn(mux, parent_id, client_id)?.spawned)
}

pub fn peel_spawn(
    mux: &mut Mux,
    parent_id: &str,
    client_id: Option<&str>,
) -> Result<PeelSpawn, MuxError> {
    let (cwd, workspace_id, peel_depth, title, seed0) = {
        let parent = mux.panes.get(parent_id).ok_or_else(|| {
            MuxError::rpc(
                "not_found",
                &format!("pane {parent_id} not found"),
                "Run gmux panes ls --json",
            )
        })?;
        if parent.peel_depth >= 2 {
            return Err(MuxError::rpc(
                "peel_bounded",
                "peel is bounded at depth 2",
                "Peel is bounded at depth 2. Spawn a template pane (gmux spawn --template tests) or return to the user.",
            ));
        }
        (
            parent.cwd.clone(),
            parent.workspace_id.clone(),
            parent.peel_depth + 1,
            placeholder_title(parent.shadow.as_str()),
            parent.shadow.as_str().to_string(),
        )
    };

    let harness_missing = mux.cached_harness_argv.is_none();
    if harness_missing {
        mux.toast("no agent harness — gmux setup");
    }
    let argv = mux.default_argv();
    let spawned = mux.spawn(SpawnOpts {
        cwd,
        argv,
        env: Default::default(),
        tab: TabSpec::New { name: title },
        focus: false,
        peel_depth,
        client_id: client_id.map(str::to_string),
        workspace_id: Some(workspace_id),
    })?;
    Ok(PeelSpawn {
        spawned,
        parent_id: parent_id.to_string(),
        seed0,
        harness_missing,
    })
}

fn placeholder_title(seed: &str) -> String {
    let words: Vec<&str> = seed.split_whitespace().take(6).collect();
    if words.is_empty() {
        return "new agent".into();
    }
    let mut title = words.join(" ");
    if title.len() > 48 {
        title.truncate(48);
    }
    title
}

pub fn shadow_extractor(seed: &str) -> &'static str {
    if seed.is_empty() { "empty" } else { "shadow" }
}

/// Slow path: extract (already timed out by the caller), clear parent, then submit.
/// Never blocks the fast spawn. Clear then submit, never the reverse.
pub async fn peel_slow<F, Fut>(
    mux: Arc<Mutex<Mux>>,
    parent_id: String,
    child_id: String,
    seed0: String,
    extract: F,
) -> PeelSlowResult
where
    F: FnOnce(Value) -> Fut,
    Fut: Future<Output = Result<ExtractReply, ExtractError>>,
{
    let grid = {
        let guard = mux.lock().expect("mux");
        match guard.read_grid(&parent_id, None) {
            Ok(snap) => serde_json::to_value(&snap).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        }
    };
    let extracted = extract(grid).await;
    let intel_down = matches!(extracted, Err(ExtractError::Down));
    let (seed, extractor, clear_keys) = match extracted {
        Ok(reply) => {
            let text = reply.text.trim().to_string();
            if !text.is_empty() {
                (text, reply.extractor, reply.clear_keys)
            } else if !seed0.is_empty() {
                (seed0.clone(), "shadow".into(), "\u{15}".into())
            } else {
                let ext = if reply.extractor.is_empty() {
                    "empty".into()
                } else {
                    reply.extractor
                };
                (String::new(), ext, reply.clear_keys)
            }
        }
        Err(_) => {
            if seed0.is_empty() {
                (String::new(), "empty".into(), "\u{15}".into())
            } else {
                (seed0.clone(), "shadow".into(), "\u{15}".into())
            }
        }
    };

    if seed.is_empty() {
        return PeelSlowResult {
            submitted: false,
            extractor,
        };
    }

    let clear = if clear_keys.is_empty() {
        "\u{15}".to_string()
    } else {
        clear_keys
    };
    {
        let mut guard = mux.lock().expect("mux");
        let _ = guard.send_keys(&parent_id, &clear);
    }
    if seed_visible(&mux, &parent_id, &seed) {
        {
            let mut guard = mux.lock().expect("mux");
            let _ = guard.send_keys(&parent_id, SECONDARY_CLEAR);
        }
    }
    if seed_visible(&mux, &parent_id, &seed) {
        let mut guard = mux.lock().expect("mux");
        guard.toast("couldn't clear parent prompt");
        if intel_down {
            guard.emit("toast", serde_json::json!({ "message": "intel down" }));
        }
        return PeelSlowResult {
            submitted: false,
            extractor,
        };
    }

    wait_harness_ready(&mux, &child_id).await;
    {
        let mut guard = mux.lock().expect("mux");
        if !guard.panes.contains_key(&child_id) {
            return PeelSlowResult {
                submitted: false,
                extractor,
            };
        }
        if guard.send_keys(&child_id, &seed).is_err() {
            return PeelSlowResult {
                submitted: false,
                extractor,
            };
        }
        let _ = guard.send_keys(&child_id, "\r");
    }
    PeelSlowResult {
        submitted: true,
        extractor,
    }
}

fn seed_visible(mux: &Arc<Mutex<Mux>>, pane_id: &str, seed: &str) -> bool {
    let guard = mux.lock().expect("mux");
    match guard.read_grid(pane_id, None) {
        Ok(snap) => grid_contains_seed(&snap, seed),
        Err(_) => false,
    }
}

pub fn grid_contains_seed(grid: &GridSnapshot, seed: &str) -> bool {
    if seed.is_empty() {
        return false;
    }
    let joined: String = grid.lines.iter().map(|l| l.text.as_str()).collect();
    if joined.contains(seed) {
        return true;
    }
    grid.lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .contains(seed)
}

async fn wait_harness_ready(mux: &Arc<Mutex<Mux>>, child_id: &str) {
    let argv = {
        let guard = mux.lock().expect("mux");
        guard
            .panes
            .get(child_id)
            .map(|p| p.argv.clone())
            .unwrap_or_default()
    };
    if !needs_composer(&argv) {
        return;
    }
    let deadline = Instant::now() + HARNESS_READY;
    while Instant::now() < deadline {
        let visible = {
            let guard = mux.lock().expect("mux");
            guard
                .read_grid(child_id, None)
                .ok()
                .map(|s| composer_visible(&s))
                .unwrap_or(false)
        };
        if visible {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn needs_composer(argv: &[String]) -> bool {
    let cmd = argv
        .first()
        .and_then(|c| std::path::Path::new(c).file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    cmd == "claude" || cmd == "codex"
}

fn composer_visible(grid: &GridSnapshot) -> bool {
    grid.lines.iter().any(|l| {
        l.text.contains('╭')
            || l.text.contains('┌')
            || l.text.contains('▍')
            || l.text.contains('>')
    })
}
