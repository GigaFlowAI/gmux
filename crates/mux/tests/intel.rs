#[path = "support/mod.rs"]
mod harness;

use gmuxd::session::WORKING_WINDOW_MS;

#[tokio::test]
async fn spawn_records_template_id_on_the_pane() {
    let h = harness::start().await;
    let pane = h.spawn_template("/tmp", "tests", "tests").await;
    let snap = h.snapshot();
    let found = snap["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["paneId"] == pane.pane_id)
        .unwrap();
    assert_eq!(found["templateId"], "tests");
}

#[tokio::test]
async fn snapshot_merges_intel_patches_by_pane_id() {
    let h = harness::start().await;
    let pane = h.spawn_shell("/tmp").await;
    h.set_intel_connected(true);
    h.report_semantics(
        &pane.pane_id,
        "waiting",
        serde_json::json!({"label": "wiring checkout retry"}),
    );
    let snap = h.snapshot();
    let found = snap["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["paneId"] == pane.pane_id)
        .unwrap();
    assert_eq!(found["state"], "waiting");
    assert_eq!(found["semantics"]["label"], "wiring checkout retry");
    assert_eq!(found["cwd"], "/tmp");
    assert_eq!(snap["intel"]["up"], true);
}

#[tokio::test]
async fn mux_only_glyphs_when_intel_down() {
    let h = harness::start().await;
    let frozen = h.spawn_shell("/tmp").await;
    h.set_intel_connected(true);
    h.report_semantics(&frozen.pane_id, "error", serde_json::json!(null));
    h.set_intel_connected(false);

    let idle = h.spawn_shell("/tmp").await;
    h.set_last_byte_ms(&idle.pane_id, 1);

    let working = h.spawn_shell("/tmp").await;
    h.feed_grid(&working.pane_id, b"hello");

    let snap = h.snapshot();
    let panes = snap["panes"].as_array().unwrap();
    let state = |id: &str| {
        panes.iter().find(|p| p["paneId"] == id).unwrap()["state"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(state(&frozen.pane_id), "error");
    assert_eq!(state(&idle.pane_id), "idle");
    assert_eq!(state(&working.pane_id), "working");
    assert_eq!(snap["intel"]["up"], false);
    let _ = WORKING_WINDOW_MS;
}

#[tokio::test]
async fn guardian_broadcast_sends_only_to_agent_panes() {
    let h = harness::start().await;
    let agent = h.spawn_shell("/tmp").await;
    let shell = h.spawn_shell("/tmp").await;
    h.report_identity(&agent.pane_id, Some("claude-code"), Some("s_1"));
    let sent = h.guardian_broadcast("slow down\n");
    assert_eq!(sent, vec![agent.pane_id]);
    assert!(!sent.contains(&shell.pane_id));
}

#[tokio::test]
async fn guardian_broadcast_delivers_to_harness_and_session_id() {
    let h = harness::start().await;
    let agent = h.spawn_shell("/tmp").await;
    let shell = h.spawn_shell("/tmp").await;
    let harness_only = h.spawn_shell("/tmp").await;
    h.report_identity(&agent.pane_id, Some("claude-code"), Some("s_web"));
    h.report_identity(&harness_only.pane_id, Some("claude-code"), None);
    let msg = "slow down\n";
    let sent = h.guardian_broadcast(msg);
    assert_eq!(sent, vec![agent.pane_id.clone()]);
    assert!(!sent.contains(&shell.pane_id));
    assert!(!sent.contains(&harness_only.pane_id));
    assert_eq!(h.last_input(&agent.pane_id), msg);
    assert_eq!(h.last_input(&shell.pane_id), "");
    assert_eq!(h.last_input(&harness_only.pane_id), "");
}
