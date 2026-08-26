//! Annotated hex fixture for the spec §1 data-plane frame packet.
//!
//! 2×1 **full** frame, cells `"A"` (fg default) and `"B"`, seq=1, pane_id 16 zero
//! bytes. All multi-byte fields little-endian. `glen` 0..8.
//!
//! ```text
//! offset  bytes                         field
//! 0       3c 00 00 00                   u32le length = 60 (bytes after this field)
//! 4       01                            type = 1 (frame)
//! 5       00                            kind = 0 (full)
//! 6       02 00                         u16le cols = 2
//! 8       01 00                         u16le rows = 1
//! 10      01 00 00 00                   u32le seq = 1
//! 14      00 × 16                       pane_id (raw ULID bytes)
//! 30      01 00 00 00                   u32le nrects = 1
//! 34      00 00                         u16le x = 0
//! 36      00 00                         u16le y = 0
//! 38      02 00                         u16le w = 2
//! 40      01 00                         u16le h = 1
//! 42      01 41 00 00 00 00 00 00 00 00 00   cell "A": glen=1, utf8, fg=0, bg=0, attrs=0
//! 53      01 42 00 00 00 00 00 00 00 00 00   cell "B"
//! ```

use std::os::unix::fs::PermissionsExt;

fn cell(s: &str) -> gmuxd::frames::Cell {
    gmuxd::frames::Cell {
        grapheme: s.to_string(),
        fg: 0,
        bg: 0,
        attrs: 0,
    }
}

/// Length-prefixed 2×1 full frame as annotated above.
const FULL_2X1: &[u8] = &[
    0x3c, 0x00, 0x00, 0x00, // u32le length = 60
    0x01, // type = 1
    0x00, // kind = 0 full
    0x02, 0x00, // cols = 2
    0x01, 0x00, // rows = 1
    0x01, 0x00, 0x00, 0x00, // seq = 1
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // pane_id
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, // nrects = 1
    0x00, 0x00, // x
    0x00, 0x00, // y
    0x02, 0x00, // w
    0x01, 0x00, // h
    0x01, b'A', 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // "A"
    0x01, b'B', 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // "B"
];

#[test]
fn full_frame_2x1_is_length_prefixed_le() {
    let bytes = gmuxd::frames::encode_full(
        /*cols*/ 2,
        /*rows*/ 1,
        /*seq*/ 1,
        /*pane ulid 16 bytes*/ &[0u8; 16],
        &[cell("A"), cell("B")],
    );
    // u32le length, then type=1, kind=0, cols=2, rows=1, seq=1, pane_id, nrects=1, rect, cells
    assert_eq!(&bytes[4..6], &[1u8, 0u8]); // type, kind — after length
    let nrects_at = 4 + 1 + 1 + 2 + 2 + 4 + 16;
    let nrects = u32::from_le_bytes(bytes[nrects_at..nrects_at + 4].try_into().unwrap());
    assert_eq!(nrects, 1);
    assert_eq!(bytes, FULL_2X1);
    let f = gmuxd::frames::decode(&bytes).unwrap();
    assert_eq!(f.kind, gmuxd::frames::Kind::Full);
    assert_eq!(f.nrects, 1);
    assert_eq!(f.cols, 2);
    assert_eq!(f.rows, 1);
    assert_eq!(f.seq, 1);
    assert_eq!(f.pane_id, [0u8; 16]);
    assert_eq!(f.rects[0].cells[0].grapheme, "A");
    assert_eq!(f.rects[0].cells[1].grapheme, "B");
}

#[test]
fn skip_if_behind_drops_pending_dirty_and_next_is_full() {
    let mut pump = gmuxd::frames::FramePump::new();
    let (seq, kind) = pump.take_send().expect("first frame");
    assert_eq!(seq, 1);
    assert_eq!(kind, gmuxd::frames::Kind::Full);

    pump.push_dirty(gmuxd::frames::Rect {
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        cells: vec![cell("X")],
    });
    assert!(
        pump.take_send().is_none(),
        "seq - last_ack > 1 must skip the dirty send"
    );
    assert_eq!(pump.pending_dirty_len(), 0, "never unbounded dirty backlog");

    pump.ack(1);
    let (seq, kind) = pump.take_send().expect("refresh after skip");
    assert_eq!(seq, 2);
    assert_eq!(kind, gmuxd::frames::Kind::Full);
}

#[tokio::test]
async fn frames_socket_mode_is_0600() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mux.frames.c_test.sock");
    let _listener = gmuxd::frames::listen(&path).unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn client_ack_input_resize_are_length_prefixed_le() {
    let ack = gmuxd::frames::encode_ack(7);
    assert_eq!(ack[4], 3);
    match gmuxd::frames::decode_client(&ack).unwrap() {
        gmuxd::frames::ClientMsg::FrameAck { seq } => assert_eq!(seq, 7),
        other => panic!("expected FrameAck, got {other:?}"),
    }

    let input = gmuxd::frames::encode_input(b"hi");
    assert_eq!(input[4], 4);
    match gmuxd::frames::decode_client(&input).unwrap() {
        gmuxd::frames::ClientMsg::Input { bytes } => assert_eq!(bytes, b"hi"),
        other => panic!("expected Input, got {other:?}"),
    }

    let resize = gmuxd::frames::encode_resize(80, 24);
    assert_eq!(resize[4], 5);
    match gmuxd::frames::decode_client(&resize).unwrap() {
        gmuxd::frames::ClientMsg::Resize { cols, rows } => {
            assert_eq!((cols, rows), (80, 24));
        }
        other => panic!("expected Resize, got {other:?}"),
    }
}

#[test]
fn ctrl_q_is_detach() {
    assert!(gmuxd::tui::is_detach_key(true, 'q'));
    assert!(gmuxd::tui::is_detach_key(true, 'Q'));
    assert!(!gmuxd::tui::is_detach_key(false, 'q'));
    assert!(!gmuxd::tui::is_detach_key(true, 'c'));
}

#[test]
fn compose_frame_inverts_cursor_cell_without_widening_packet() {
    let mut pump = gmuxd::frames::FramePump::new();
    let mut cache = gmuxd::frames::FrameCache::new();
    let bytes = gmuxd::frames::compose_frame(
        &mut pump,
        &mut cache,
        2,
        1,
        [0u8; 16],
        vec![cell("A"), cell("B")],
        (1, 0),
    )
    .unwrap();
    assert_eq!(&bytes[4..6], &[1u8, 0u8]); // still type=1, kind=full; no cursor field
    let f = gmuxd::frames::decode(&bytes).unwrap();
    assert_eq!(f.rects[0].cells[0].grapheme, "A");
    assert_eq!(f.rects[0].cells[0].attrs & gmuxd::frames::ATTR_INVERSE, 0);
    assert_eq!(f.rects[0].cells[1].grapheme, "B");
    assert_eq!(
        f.rects[0].cells[1].attrs & gmuxd::frames::ATTR_INVERSE,
        gmuxd::frames::ATTR_INVERSE,
        "cursor cell must be inverted at encode time"
    );
}

#[test]
fn compose_frame_focus_change_is_full_not_dirty() {
    let mut pump = gmuxd::frames::FramePump::new();
    let mut cache = gmuxd::frames::FrameCache::new();
    let pane_a = [1u8; 16];
    let pane_b = [2u8; 16];
    let f1 = gmuxd::frames::compose_frame(
        &mut pump,
        &mut cache,
        2,
        1,
        pane_a,
        vec![cell("A"), cell("A")],
        (0, 0),
    )
    .unwrap();
    assert_eq!(
        gmuxd::frames::decode(&f1).unwrap().kind,
        gmuxd::frames::Kind::Full
    );
    pump.ack(1);
    let f2 = gmuxd::frames::compose_frame(
        &mut pump,
        &mut cache,
        2,
        1,
        pane_b,
        vec![cell("B"), cell("B")],
        (0, 0),
    )
    .unwrap();
    let d = gmuxd::frames::decode(&f2).unwrap();
    assert_eq!(
        d.kind,
        gmuxd::frames::Kind::Full,
        "focus change must not dirty-diff pane B against pane A"
    );
    assert_eq!(d.pane_id, pane_b);
    assert_eq!(d.rects[0].cells[0].grapheme, "B");
}
