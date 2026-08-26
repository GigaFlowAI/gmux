//! Mux-local peel: fast spawn from shadow, then slow extract/clear/submit.
//!
//! Fast path must not await intel. Clear then submit, never the reverse.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::grid::GridSnapshot;
use crate::session::{Mux, MuxError, SpawnOpts, Spawned, TabSpec};

const SECONDARY_CLEAR: &str = "\x01\x0b";
const HARNESS_READY: Duration = Duration::from_secs(8);
/// Wait for the parent PTY to redraw after clearKeys. Immediate re-read is
/// always stale — Claude paints the composer asynchronously.
const CLEAR_POLL: Duration = Duration::from_millis(80);
const CLEAR_TICK: Duration = Duration::from_millis(5);
/// Keep in sync with `CONTEXT_PACK_BUDGET_MS` / `PACK_TIMEOUT_MS` (500).
pub const PACK_TIMEOUT: Duration = Duration::from_millis(500);

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
    /// Body written to the child before Enter. None when submit was skipped.
    pub submitted_text: Option<String>,
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

#[derive(Debug, Clone)]
pub struct PackReply {
    pub text: String,
}

impl PackReply {
    pub fn from_value(v: &Value) -> Option<Self> {
        let text = v.get("text").and_then(Value::as_str)?;
        Some(Self {
            text: text.to_string(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackError {
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

fn skipped(extractor: String) -> PeelSlowResult {
    PeelSlowResult {
        submitted: false,
        extractor,
        submitted_text: None,
    }
}

/// Slow path: extract (already timed out by the caller), clear parent, then submit.
/// Never blocks the fast spawn. Clear then submit, never the reverse.
/// Pack runs only after a successful clear (uncleared parent → pack dropped).
/// 500 ms budget then seed+headline; a late pack is not a second submit.
pub async fn peel_slow<F, Fut, P, PFut>(
    mux: Arc<Mutex<Mux>>,
    parent_id: String,
    child_id: String,
    seed0: String,
    extract: F,
    pack: P,
) -> PeelSlowResult
where
    F: FnOnce(Value) -> Fut,
    Fut: Future<Output = Result<ExtractReply, ExtractError>>,
    P: FnOnce(Value) -> PFut,
    PFut: Future<Output = Result<PackReply, PackError>>,
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
        if intel_down {
            mux.lock().expect("mux").toast("intel down");
        }
        return skipped(extractor);
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
    if !wait_seed_gone(&mux, &parent_id, &seed).await {
        {
            let mut guard = mux.lock().expect("mux");
            let _ = guard.send_keys(&parent_id, SECONDARY_CLEAR);
        }
        if !wait_seed_gone(&mux, &parent_id, &seed).await {
            let mut guard = mux.lock().expect("mux");
            guard.toast("couldn't clear parent prompt");
            if intel_down {
                guard.toast("intel down");
            }
            return skipped(extractor);
        }
    }

    let (pack_params, headline) = {
        let guard = mux.lock().expect("mux");
        (
            pack_params(&guard, &parent_id, &seed),
            parent_headline(&guard, &parent_id),
        )
    };
    let pack_fut = pack(pack_params);
    let ready_fut = wait_harness_ready(&mux, &child_id);
    let (packed, _) = tokio::join!(tokio::time::timeout(PACK_TIMEOUT, pack_fut), ready_fut,);
    let body = match packed {
        Ok(Ok(reply)) if !reply.text.is_empty() => reply.text,
        _ => seed_and_headline(&seed, headline.as_deref()),
    };

    {
        let mut guard = mux.lock().expect("mux");
        if !guard.panes.contains_key(&child_id) {
            return skipped(extractor);
        }
        if guard.send_keys(&child_id, &body).is_err() {
            return skipped(extractor);
        }
        let _ = guard.send_keys(&child_id, "\r");
    }
    PeelSlowResult {
        submitted: true,
        extractor,
        submitted_text: Some(body),
    }
}

fn pack_params(mux: &Mux, parent_id: &str, seed: &str) -> Value {
    let pane = mux.panes.get(parent_id);
    json!({
        "parentPaneId": parent_id,
        "seed": seed,
        "harness": pane.and_then(|p| p.harness.clone()),
        "sessionId": pane.and_then(|p| p.session_id.clone()),
        "semantics": mux.patches.get(parent_id).and_then(|p| p.semantics.clone()),
    })
}

fn parent_headline(mux: &Mux, parent_id: &str) -> Option<String> {
    mux.patches
        .get(parent_id)
        .and_then(|p| p.semantics.as_ref())
        .and_then(|s| s.get("label"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn seed_and_headline(seed: &str, headline: Option<&str>) -> String {
    match headline.map(str::trim).filter(|s| !s.is_empty()) {
        Some(h) => format!("{seed}\n\n{h}"),
        None => seed.to_string(),
    }
}

fn seed_visible(mux: &Arc<Mutex<Mux>>, pane_id: &str, seed: &str) -> bool {
    let guard = mux.lock().expect("mux");
    match guard.read_grid(pane_id, None) {
        Ok(snap) => grid_contains_seed(&snap, seed),
        Err(_) => false,
    }
}

async fn wait_seed_gone(mux: &Arc<Mutex<Mux>>, pane_id: &str, seed: &str) -> bool {
    let deadline = Instant::now() + CLEAR_POLL;
    loop {
        if !seed_visible(mux, pane_id, seed) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(CLEAR_TICK).await;
    }
}

/// True when `seed` is still a visible prompt, surviving box `│` wrapping and
/// stripped `>` prefixes — the same chrome extract drops when it builds the seed.
pub fn grid_contains_seed(grid: &GridSnapshot, seed: &str) -> bool {
    if seed.is_empty() {
        return false;
    }
    let stripped: Vec<String> = grid
        .lines
        .iter()
        .map(|l| strip_prompt_chrome(&l.text))
        .collect();
    let extracted_like = stripped.join("\n");
    if extracted_like.contains(seed) {
        return true;
    }
    let wrapped: String = stripped.iter().map(|s| s.trim_end()).collect();
    if wrapped.contains(seed) {
        return true;
    }
    let hay: String = wrapped.chars().filter(|c| !c.is_whitespace()).collect();
    let needle: String = seed.chars().filter(|c| !c.is_whitespace()).collect();
    !needle.is_empty() && hay.contains(&needle)
}

fn strip_prompt_chrome(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut start = 0;
    let mut end = chars.len();
    if end > start && matches!(chars[start], '│' | '┃' | '|') {
        start += 1;
    }
    if end > start && matches!(chars[end - 1], '│' | '┃' | '|') {
        end -= 1;
    }
    let slice = &chars[start..end];
    let mut i = 0;
    while i < slice.len() && slice[i] == ' ' {
        i += 1;
    }
    if i < slice.len() && matches!(slice[i], '>' | '›') {
        i += 1;
        if i < slice.len() && slice[i] == ' ' {
            i += 1;
        }
    }
    slice[i..].iter().collect()
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

pub(crate) fn composer_visible(grid: &GridSnapshot) -> bool {
    has_box_pair(grid) || has_caret_line(grid)
}

fn has_box_pair(grid: &GridSnapshot) -> bool {
    let top = grid.lines.iter().any(|l| {
        (l.text.contains('╭') && l.text.contains('╮'))
            || (l.text.contains('┌') && l.text.contains('┐'))
    });
    let bot = grid.lines.iter().any(|l| {
        (l.text.contains('╰') && l.text.contains('╯'))
            || (l.text.contains('└') && l.text.contains('┘'))
    });
    top && bot
}

fn has_caret_line(grid: &GridSnapshot) -> bool {
    grid.lines.iter().any(|l| is_caret_line(&l.text))
}

/// Caret / prompt line, not a `>` inside a diff or comparison.
fn is_caret_line(text: &str) -> bool {
    if text.contains('▍') {
        return true;
    }
    let mut t = text.trim_start();
    t = t.trim_start_matches(['│', '┃', '|']);
    t = t.trim_start();
    t.starts_with('>') || t.starts_with('›')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::GridLine;

    fn snap(lines: &[&str]) -> GridSnapshot {
        GridSnapshot {
            pane_id: "p_x".into(),
            cols: 40,
            rows: lines.len() as u16,
            lines: lines
                .iter()
                .map(|t| GridLine {
                    text: (*t).into(),
                    intensity: vec![],
                })
                .collect(),
            alternate_screen: true,
            foreground_command: "claude".into(),
        }
    }

    #[test]
    fn seed_visible_through_box_prefix() {
        let g = snap(&["│ > also fix the webhook                       │"]);
        assert!(grid_contains_seed(&g, "also fix the webhook"));
    }

    #[test]
    fn seed_visible_through_wrapped_box() {
        let g = snap(&["│ > also fix the we│", "│ bhook            │"]);
        assert!(grid_contains_seed(&g, "also fix the webhook"));
        let joined: String = g.lines.iter().map(|l| l.text.as_str()).collect();
        assert!(
            !joined.contains("also fix the webhook"),
            "raw dump must not already contain the seed"
        );
    }

    #[test]
    fn composer_rejects_gt_in_a_diff() {
        let g = snap(&["+    if (a > b) {", "@@ -1,3 +1,4 @@"]);
        assert!(!composer_visible(&g));
    }

    #[test]
    fn composer_accepts_box_pair_and_caret() {
        let boxed = snap(&[
            "╭──────────────────╮",
            "│ > also fix       │",
            "╰──────────────────╯",
        ]);
        assert!(composer_visible(&boxed));
        assert!(composer_visible(&snap(&["> also fix the webhook"])));
        assert!(composer_visible(&snap(&["also fix▍"])));
        assert!(!composer_visible(&snap(&["╭──────────────────╮"])));
    }
}
