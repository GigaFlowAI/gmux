#[path = "support/mod.rs"]
mod harness;

#[tokio::test]
async fn peel_spawns_from_shadow_without_intel() {
    let h = harness::start().await; // test helper: gmuxd in-process, temp dir
    let parent = h.spawn_shell("/tmp").await;
    h.set_client_focus("c1", &parent.pane_id);
    h.write_input(&parent.pane_id, b"also fix the webhook")
        .await;
    let t0 = std::time::Instant::now();
    let child = h.peel("c1").await.unwrap();
    assert!(t0.elapsed() < std::time::Duration::from_millis(50));
    assert_ne!(h.focused("c1"), child.pane_id);
    assert_eq!(h.focused("c1"), parent.pane_id);
    assert_ne!(child.tab_id, parent.tab_id);
}

#[tokio::test]
async fn pane_peels_from_self_without_client_focus() {
    let h = harness::start().await;
    let parent = h.spawn_shell("/tmp").await;
    h.write_input(&parent.pane_id, b"also fix the webhook")
        .await;
    let child = h.peel_from_pane(&parent.pane_id).await.unwrap();
    assert_ne!(child.pane_id, parent.pane_id);
    assert_ne!(child.tab_id, parent.tab_id);
}
