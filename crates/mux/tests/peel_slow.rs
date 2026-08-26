//! Peel failure matrix: empty seed, intel down, timeout, uncleared, peel_bounded, harness missing.

#[path = "support/mod.rs"]
mod harness;

use gmuxd::peel::{ExtractError, ExtractReply};

fn reply(text: &str, extractor: &str) -> ExtractReply {
    ExtractReply {
        text: text.into(),
        confidence: "high".into(),
        clear_keys: "\u{15}".into(),
        extractor: extractor.into(),
    }
}

#[tokio::test]
async fn empty_seed_spawns_blank_no_submit() {
    let h = harness::start().await;
    let parent = h.spawn_shell("/tmp").await;
    h.set_client_focus("c1", &parent.pane_id);
    let t0 = std::time::Instant::now();
    let spawned = h.peel_spawn("c1").unwrap();
    assert!(t0.elapsed() < std::time::Duration::from_millis(50));
    assert!(spawned.seed0.is_empty());
    let slow = h
        .peel_slow(
            &spawned.parent_id,
            &spawned.spawned.pane_id,
            &spawned.seed0,
            Ok(reply("", "empty")),
        )
        .await;
    assert!(!slow.submitted);
    assert_eq!(slow.extractor, "empty");
}

#[tokio::test]
async fn intel_down_uses_shadow_and_submits_if_cleared() {
    let h = harness::start().await;
    let parent = h.spawn_shell("/tmp").await;
    h.set_client_focus("c1", &parent.pane_id);
    h.set_shadow(&parent.pane_id, "also fix the webhook");
    let spawned = h.peel_spawn("c1").unwrap();
    assert_eq!(spawned.seed0, "also fix the webhook");
    let slow = h
        .peel_slow(
            &spawned.parent_id,
            &spawned.spawned.pane_id,
            &spawned.seed0,
            Err(ExtractError::Down),
        )
        .await;
    // Grid never showed the seed, so mux-local confirm treats it as cleared.
    assert!(slow.submitted);
    assert_eq!(slow.extractor, "shadow");
}

#[tokio::test]
async fn extract_timeout_falls_back_to_shadow() {
    let h = harness::start().await;
    let parent = h.spawn_shell("/tmp").await;
    h.set_client_focus("c1", &parent.pane_id);
    h.set_shadow(&parent.pane_id, "also fix the webhook");
    let spawned = h.peel_spawn("c1").unwrap();
    let slow = h
        .peel_slow(
            &spawned.parent_id,
            &spawned.spawned.pane_id,
            &spawned.seed0,
            Err(ExtractError::Timeout),
        )
        .await;
    assert!(slow.submitted);
    assert_eq!(slow.extractor, "shadow");
}

#[tokio::test]
async fn uncleared_parent_does_not_submit() {
    let h = harness::start().await;
    let parent = h.spawn_shell("/tmp").await;
    h.set_client_focus("c1", &parent.pane_id);
    h.set_shadow(&parent.pane_id, "also fix the webhook");
    h.feed_grid(&parent.pane_id, b"also fix the webhook");
    let spawned = h.peel_spawn("c1").unwrap();
    let slow = h
        .peel_slow(
            &spawned.parent_id,
            &spawned.spawned.pane_id,
            &spawned.seed0,
            Ok(reply("also fix the webhook", "claude-code")),
        )
        .await;
    assert!(!slow.submitted);
    assert_eq!(h.status().as_deref(), Some("couldn't clear parent prompt"));
}

#[tokio::test]
async fn peel_depth_two_is_bounded() {
    let h = harness::start().await;
    let parent = h.spawn_shell("/tmp").await;
    h.set_peel_depth(&parent.pane_id, 2);
    let err = h.peel_from_pane(&parent.pane_id).await.unwrap_err();
    assert_eq!(err.code(), "peel_bounded");
}

#[tokio::test]
async fn harness_missing_spawns_shell_and_sets_status() {
    let h = harness::start().await;
    h.clear_harness_argv();
    let parent = h.spawn_shell("/tmp").await;
    h.set_client_focus("c1", &parent.pane_id);
    let spawned = h.peel_spawn("c1").unwrap();
    assert_eq!(h.status().as_deref(), Some("no agent harness — gmux setup"));
    assert!(spawned.harness_missing);
    let argv = h.argv(&spawned.spawned.pane_id);
    assert!(
        argv.first().map(|s| s.as_str()) == Some("/bin/sh")
            || argv
                .first()
                .map(|s| s.contains("sh") || s.contains("zsh") || s.contains("bash"))
                .unwrap_or(false),
        "expected $SHELL, got {argv:?}"
    );
}

#[tokio::test]
async fn fast_peel_does_not_wait_on_extract() {
    let h = harness::start().await;
    let parent = h.spawn_shell("/tmp").await;
    h.set_client_focus("c1", &parent.pane_id);
    h.set_shadow(&parent.pane_id, "also fix the webhook");
    let t0 = std::time::Instant::now();
    let _ = h.peel("c1").await.unwrap();
    assert!(t0.elapsed() < std::time::Duration::from_millis(50));
}
