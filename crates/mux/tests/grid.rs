//! Recorded ANSI fixtures for the VTE grid and compact-line scrollback.

#[path = "support/mod.rs"]
mod harness;

use gmuxd::grid::Grid;

/// SGR 2 (dim) then reset then SGR 1 (bold). 4-col × 1-row grid.
const FIXTURE_DIM_BOLD: &[u8] = b"\x1b[2mdim\x1b[0m\x1b[1mB";

/// Two LF-terminated lines, then an incomplete third.
const FIXTURE_LF_LINES: &[u8] = b"hello\nworld\n";

/// Primary line, enter alt screen, print there, leave alt screen.
const FIXTURE_ALT_SCREEN: &[u8] = b"keep\n\x1b[?1049halt\nsecret\n\x1b[?1049l";

/// Inverse and truecolor RGB — ignored for extract intensity.
const FIXTURE_INVERSE_RGB: &[u8] = b"\x1b[7mI\x1b[0m\x1b[38;2;255;0;0mR";

#[test]
fn dim_is_intensity_0_bold_is_2() {
    let mut g = gmuxd::grid::Grid::new(4, 1);
    g.feed(FIXTURE_DIM_BOLD);
    let snap = g.snapshot("p_TEST", "zsh");
    assert_eq!(snap.lines[0].text.chars().next(), Some('d'));
    assert_eq!(snap.lines[0].intensity[0], 0);
    // last cell bold
    assert_eq!(*snap.lines[0].intensity.last().unwrap(), 2);
}

#[test]
fn snapshot_json_matches_ts_grid_snapshot() {
    let mut g = Grid::new(4, 1);
    g.feed(FIXTURE_DIM_BOLD);
    let snap = g.snapshot("p_TEST", "zsh");
    let v = serde_json::to_value(&snap).unwrap();
    assert_eq!(v["paneId"], "p_TEST");
    assert_eq!(v["cols"], 4);
    assert_eq!(v["rows"], 1);
    assert_eq!(v["alternateScreen"], false);
    assert_eq!(v["foregroundCommand"], "zsh");
    assert_eq!(v["lines"][0]["text"], "dimB");
    assert_eq!(v["lines"][0]["intensity"], serde_json::json!([0, 0, 0, 2]));
    assert!(v.get("pane_id").is_none());
    assert!(v.get("alternate_screen").is_none());
}

#[test]
fn lf_pushes_compact_line_text_not_cells() {
    let mut g = Grid::new(8, 2);
    g.feed(FIXTURE_LF_LINES);
    assert_eq!(g.read_lines(None), "hello\nworld");
    assert_eq!(g.read_lines(Some(1)), "world");
}

#[test]
fn alt_screen_lf_does_not_push_scrollback() {
    let mut g = Grid::new(8, 2);
    g.feed(FIXTURE_ALT_SCREEN);
    assert_eq!(g.read_lines(None), "keep");
    let snap = g.snapshot("p_TEST", "zsh");
    assert!(!snap.alternate_screen);
}

#[test]
fn resize_in_alt_screen_preserves_primary() {
    let mut g = Grid::new(4, 2);
    g.feed(b"keep");
    g.feed(b"\x1b[?1049h");
    g.feed(b"alt!");
    g.resize(3, 2);
    let alt = g.snapshot("p_TEST", "vim");
    assert!(alt.alternate_screen);
    assert_eq!(alt.cols, 3);
    assert_eq!(alt.lines[0].text, "alt");
    g.feed(b"\x1b[?1049l");
    let snap = g.snapshot("p_TEST", "zsh");
    assert!(!snap.alternate_screen);
    assert_eq!(snap.cols, 3);
    assert_eq!(
        snap.lines[0].text, "kee",
        "resize must clip/copy saved_cells, not blank the primary"
    );
}

#[test]
fn inverse_and_rgb_are_intensity_1() {
    let mut g = Grid::new(4, 1);
    g.feed(FIXTURE_INVERSE_RGB);
    let snap = g.snapshot("p_TEST", "zsh");
    assert_eq!(snap.lines[0].text.chars().next(), Some('I'));
    assert_eq!(snap.lines[0].intensity[0], 1);
    assert_eq!(*snap.lines[0].intensity.last().unwrap(), 1);
}

#[test]
fn scrollback_caps_at_10_000_lines() {
    let mut g = Grid::new(16, 2);
    for i in 0..10_010 {
        g.feed(format!("L{i}\n").as_bytes());
    }
    let text = g.read_lines(None);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 10_000);
    assert_eq!(lines[0], "L10");
    assert_eq!(lines[9999], "L10009");
}

#[test]
fn snapshot_last_rows_is_visible_tail() {
    let mut g = Grid::new(4, 3);
    g.feed(b"aaa\nbbb\nccc");
    let snap = g.snapshot_rows("p_TEST", "zsh", Some(2));
    assert_eq!(snap.lines.len(), 2);
    assert_eq!(snap.lines[0].text, "bbb");
    assert_eq!(snap.lines[1].text, "ccc");
    assert_eq!(snap.rows, 3);
}

#[tokio::test]
async fn pane_read_grid_and_lines() {
    let h = harness::start().await;
    let spawned = h.spawn_shell("/tmp").await;
    h.feed_grid(&spawned.pane_id, FIXTURE_DIM_BOLD);
    h.feed_grid(&spawned.pane_id, b"\nhello\n");

    let grid = h.read_pane(&spawned.pane_id, "grid", None);
    assert_eq!(grid["paneId"], spawned.pane_id.as_str());
    assert_eq!(grid["foregroundCommand"], "sleep");
    assert!(grid.get("lines").is_some());
    assert!(grid.get("alternateScreen").is_some());
    assert_eq!(grid["lines"][0]["intensity"][0], 0);

    let lines = h.read_pane(&spawned.pane_id, "lines", Some(1));
    assert_eq!(lines["text"], "hello");
}
