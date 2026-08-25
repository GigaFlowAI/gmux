//! Mux-local peel: seed from shadow, spawn a new tab, do not RPC intel.

use crate::session::{Mux, MuxError, SpawnOpts, Spawned, TabSpec};

/// Fast path for a TUI/cli client: peel **this client's** focused pane.
pub fn peel(mux: &mut Mux, client_id: &str) -> Result<Spawned, MuxError> {
    let parent_id = mux.focused(client_id).map(str::to_string).ok_or_else(|| {
        MuxError::rpc(
            "not_found",
            "no focused pane for this client",
            "Focus a pane or pass --from <paneId>",
        )
    })?;
    peel_from_pane(mux, &parent_id, Some(client_id))
}

/// Fast path for a pane caller: peel **from self**. `focus: false`.
pub fn peel_from_pane(
    mux: &mut Mux,
    parent_id: &str,
    client_id: Option<&str>,
) -> Result<Spawned, MuxError> {
    let (cwd, workspace_id, peel_depth, title) = {
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
        )
    };

    let argv = mux.default_argv();
    mux.spawn(SpawnOpts {
        cwd,
        argv,
        env: Default::default(),
        tab: TabSpec::New { name: title },
        focus: false,
        peel_depth,
        client_id: client_id.map(str::to_string),
        workspace_id: Some(workspace_id),
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
