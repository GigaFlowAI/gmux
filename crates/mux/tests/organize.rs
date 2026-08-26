//! Grouping verbs: tabs are groups, not tiles. No select-layout / swap.

#[path = "support/mod.rs"]
mod harness;

#[tokio::test]
async fn new_tab_rename_move_break() {
    let h = harness::start().await;
    let spawned = h.spawn_shell("/tmp").await;
    let tab = h.mux().lock().unwrap().new_tab("web", None).unwrap();
    h.mux().lock().unwrap().rename_tab(&tab, "webshop").unwrap();
    h.mux()
        .lock()
        .unwrap()
        .move_pane(&spawned.pane_id, &tab)
        .unwrap();

    let snap = h.snapshot();
    let pane = snap["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["paneId"] == spawned.pane_id)
        .unwrap();
    assert_eq!(pane["tabId"], tab);

    let tabs = snap["workspaces"][0]["tabs"].as_array().unwrap();
    let named = tabs.iter().find(|t| t["id"] == tab).unwrap();
    assert_eq!(named["name"], "webshop");

    let broken = h
        .mux()
        .lock()
        .unwrap()
        .break_pane(&spawned.pane_id, Some("solo"))
        .unwrap();
    assert_ne!(broken, tab);
    let snap = h.snapshot();
    let pane = snap["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["paneId"] == spawned.pane_id)
        .unwrap();
    assert_eq!(pane["tabId"], broken);
}

#[tokio::test]
async fn apply_v2_plan_moves_pane_into_new_tab() {
    let h = harness::start().await;
    let spawned = h.spawn_shell("/r/web").await;
    let plan = serde_json::json!({
        "schemaVersion": 2,
        "summary": "1 project tab(s), 1 pane(s) moved",
        "steps": [
            { "op": "new-tab", "handle": "t:web", "name": "web", "description": "Create tab \"web\"" },
            { "op": "move-pane", "paneId": spawned.pane_id, "to": { "kind": "handle", "handle": "t:web" }, "description": "move" }
        ]
    });
    let result = h.mux().lock().unwrap().apply_organize_plan(&plan).unwrap();
    assert_eq!(result["skipped"].as_array().unwrap().len(), 0);
    assert_eq!(result["applied"].as_array().unwrap().len(), 2);
    let snap = h.snapshot();
    let pane = snap["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["paneId"] == spawned.pane_id)
        .unwrap();
    let dest = snap["workspaces"][0]["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "web")
        .unwrap();
    assert_eq!(pane["tabId"], dest["id"]);
}

#[tokio::test]
async fn missing_tab_is_skipped_not_invented() {
    let h = harness::start().await;
    let spawned = h.spawn_shell("/tmp").await;
    let src_tab = spawned.tab_id.clone();
    let plan = serde_json::json!({
        "schemaVersion": 2,
        "summary": "s",
        "steps": [{
            "op": "move-pane",
            "paneId": spawned.pane_id,
            "to": { "kind": "tab", "tabId": "t_ghost" },
            "description": "x"
        }]
    });
    let result = h.mux().lock().unwrap().apply_organize_plan(&plan).unwrap();
    assert_eq!(result["applied"].as_array().unwrap().len(), 0);
    assert_eq!(
        result["skipped"][0]["reason"].as_str().unwrap(),
        "tab t_ghost not present"
    );
    let snap = h.snapshot();
    let pane = snap["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["paneId"] == spawned.pane_id)
        .unwrap();
    assert_eq!(pane["tabId"], src_tab);
    let tabs = snap["workspaces"][0]["tabs"].as_array().unwrap();
    assert!(tabs.iter().all(|t| t["id"] != "t_ghost"));
}

#[tokio::test]
async fn move_pane_prunes_empty_source_tab() {
    let h = harness::start().await;
    let spawned = h.spawn_shell("/tmp").await;
    let src = spawned.tab_id.clone();
    let dest = h.mux().lock().unwrap().new_tab("web", None).unwrap();
    h.mux()
        .lock()
        .unwrap()
        .move_pane(&spawned.pane_id, &dest)
        .unwrap();
    let snap = h.snapshot();
    let tabs = snap["workspaces"][0]["tabs"].as_array().unwrap();
    assert!(tabs.iter().all(|t| t["id"] != src), "empty source tab {src} must be pruned");
    assert!(tabs.iter().any(|t| t["id"] == dest));
}

#[tokio::test]
async fn v1_plan_is_not_applied() {
    let h = harness::start().await;
    let plan = serde_json::json!({
        "schemaVersion": 1,
        "summary": "legacy",
        "steps": [{ "op": "new-tab", "handle": "t:x", "name": "x", "description": "create" }]
    });
    let result = h.mux().lock().unwrap().apply_organize_plan(&plan).unwrap();
    assert_eq!(result["applied"].as_array().unwrap().len(), 0);
    assert_eq!(result["skipped"].as_array().unwrap().len(), 1);
}
