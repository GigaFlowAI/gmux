use gmuxd::protocol::filter_snapshot_to_workspace;
use serde_json::json;

#[test]
fn pane_snapshot_hides_other_workspaces_panes_and_clients() {
    let mut snap = json!({
        "workspaces": [
            {"id": "ws_a", "cwd": "/a", "tabs": []},
            {"id": "ws_b", "cwd": "/b", "tabs": []}
        ],
        "panes": [
            {"paneId": "p_a", "workspaceId": "ws_a", "tabId": "t_a"},
            {"paneId": "p_b", "workspaceId": "ws_b", "tabId": "t_b"}
        ],
        "clients": [
            {"id": "c1", "focusedPaneId": "p_a", "cols": 80, "rows": 24},
            {"id": "c2", "focusedPaneId": "p_b", "cols": 80, "rows": 24},
            {"id": "c3", "focusedPaneId": null, "cols": 80, "rows": 24}
        ]
    });
    filter_snapshot_to_workspace(&mut snap, "ws_a");
    let workspaces = snap["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0]["id"], "ws_a");
    let panes = snap["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0]["paneId"], "p_a");
    let clients = snap["clients"].as_array().unwrap();
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0]["id"], "c1");
}
