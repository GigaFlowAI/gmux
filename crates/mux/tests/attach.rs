//! Empty-session bootstrap, per-client focus, detach-without-SIGHUP, resize.

#[path = "support/mod.rs"]
mod harness;

use gmuxd::session::workspace_id_for;

#[tokio::test]
async fn empty_attach_bootstraps_workspace_tab_shell() {
    let h = harness::start().await;
    let client = h.attach();
    assert!(client.focused_pane_id.is_some(), "focus:true on $SHELL");
    let snap = h.snapshot();
    let workspaces = snap["workspaces"].as_array().expect("workspaces");
    assert_eq!(workspaces.len(), 1);
    let id = workspaces[0]["id"].as_str().expect("id");
    assert!(id.starts_with("ws_"));
    assert_eq!(id.len(), 15, "ws_ + 12-char hex");
    let tabs = workspaces[0]["tabs"].as_array().expect("tabs");
    assert!(
        tabs.iter().any(|t| t["name"] == "main"),
        "tab main: {tabs:?}"
    );
    let panes = snap["panes"].as_array().expect("panes");
    assert!(!panes.is_empty());
}

#[tokio::test]
async fn two_clients_have_own_focus_and_frame_paths() {
    let h = harness::start().await;
    let c1 = h.attach();
    let c2 = h.attach();
    assert_ne!(c1.id, c2.id);
    assert!(c1.focused_pane_id.is_some());
    assert!(c2.focused_pane_id.is_some());

    let p1 = h.paths().frames_socket_path(&c1.id);
    let p2 = h.paths().frames_socket_path(&c2.id);
    assert_ne!(p1, p2);
    assert!(
        p1.file_name()
            .unwrap()
            .to_string_lossy()
            .eq(&format!("mux.frames.{}.sock", c1.id))
    );

    let extra = h.spawn_shell("/tmp").await;
    h.set_client_focus(&c1.id, &extra.pane_id);
    assert_eq!(h.focused(&c1.id), extra.pane_id);
    assert_eq!(h.focused(&c2.id), c2.focused_pane_id.unwrap());
}

#[tokio::test]
async fn detach_does_not_kill_panes() {
    let h = harness::start().await;
    let c = h.attach();
    let pane = c.focused_pane_id.clone().unwrap();
    h.detach(&c.id);
    assert!(h.has_pane(&pane), "ctrl+q detach must not SIGHUP");
    assert!(!h.has_client(&c.id));
    assert!(h.focused_opt(&c.id).is_none());
}

#[tokio::test]
async fn resize_this_client_resizes_focused_grid() {
    let h = harness::start().await;
    let c = h.attach();
    let pane = c.focused_pane_id.clone().unwrap();
    h.resize(&c.id, 40, 12);
    assert_eq!(h.grid_size(&pane), (40, 12));
}

#[tokio::test]
async fn focus_client_moves_this_client_and_resizes_pane() {
    let h = harness::start().await;
    let c = h.attach();
    h.resize(&c.id, 40, 12);
    let extra = h.spawn_shell("/tmp").await;
    h.mux()
        .lock()
        .unwrap()
        .focus_client(&c.id, &extra.pane_id)
        .unwrap();
    assert_eq!(h.focused(&c.id), extra.pane_id);
    assert_eq!(h.grid_size(&extra.pane_id), (40, 12));
}

#[test]
fn workspace_id_is_ws_plus_12_hex_sha256() {
    let dir = tempfile::tempdir().unwrap();
    let id = workspace_id_for(dir.path());
    assert!(id.starts_with("ws_"));
    assert_eq!(id.len(), 15);
    assert!(
        id[3..].chars().all(|c| c.is_ascii_hexdigit()),
        "12 hex chars: {id}"
    );
}

#[test]
fn workspace_id_uses_git_root_not_nested_cwd() {
    let dir = tempfile::tempdir().unwrap();
    let git = std::process::Command::new("git")
        .args(["-C", dir.path().to_str().unwrap(), "init"])
        .output()
        .unwrap();
    assert!(
        git.status.success(),
        "git init: {}",
        String::from_utf8_lossy(&git.stderr)
    );
    let nested = dir.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    let a = workspace_id_for(dir.path());
    let b = workspace_id_for(&nested);
    assert_eq!(a, b);
}

#[tokio::test]
async fn data_plane_streams_this_clients_focused_pane() {
    let h = harness::start().await;
    let c = h.attach();
    let pane_id = c.focused_pane_id.clone().unwrap();
    let pane_bytes = h.pane_id_bytes(&pane_id);
    h.feed_grid(&pane_id, b"AB");

    // macOS sun_path is 104 bytes; tempfile cache dirs overflow with c_<ulid>.
    let path = std::env::temp_dir().join(format!("gmf{}-t4.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = gmuxd::frames::listen(&path).unwrap();
    let mux = h.mux();
    let id = c.id.clone();
    tokio::spawn(async move {
        gmuxd::frames::serve(mux, id, listener).await;
    });

    let mut stream = None;
    for _ in 0..50 {
        match tokio::net::UnixStream::connect(&path).await {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(20)).await,
        }
    }
    let mut stream = stream.expect("frames socket accept");
    let pkt = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        gmuxd::frames::read_packet(&mut stream),
    )
    .await
    .expect("frame timeout")
    .expect("frame read");
    let f = gmuxd::frames::decode(&pkt).unwrap();
    assert_eq!(f.kind, gmuxd::frames::Kind::Full);
    assert_eq!(f.pane_id, pane_bytes);
    assert_eq!(f.nrects, 1);
    assert_eq!(f.rects[0].cells[0].grapheme, "A");
    assert_eq!(f.rects[0].cells[1].grapheme, "B");
    let _ = std::fs::remove_file(&path);
}
