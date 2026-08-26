//! Binary data plane: length-prefixed little-endian dirty-rect frames.
//!
//! Packet layout is spec §1. One Unix socket per `client.attach`
//! (`mux.frames.<clientId>.sock`, mode 0o600). Streams **this client's**
//! focused pane only. Skip-if-behind: `seq - last_ack > 1` drops pending
//! dirty rects and the next frame is `kind = full`.

use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener as StdUnixListener;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;

use crate::session::Mux;

pub const TYPE_FRAME: u8 = 1;
pub const TYPE_ACK: u8 = 3;
pub const TYPE_INPUT: u8 = 4;
pub const TYPE_RESIZE: u8 = 5;
pub const TYPE_MOUSE: u8 = 6;
/// Wire attrs bit3: inverse. Set on the cursor cell at encode time (not a packet field).
pub const ATTR_INVERSE: u8 = 1 << 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Full = 0,
    Dirty = 1,
}

impl Kind {
    fn from_u8(v: u8) -> Result<Self, FrameError> {
        match v {
            0 => Ok(Self::Full),
            1 => Ok(Self::Dirty),
            other => Err(FrameError::Kind(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    pub grapheme: String,
    pub fg: u32,
    pub bg: u32,
    pub attrs: u8,
}

impl Cell {
    pub fn blank() -> Self {
        Self {
            grapheme: String::new(),
            fg: 0,
            bg: 0,
            attrs: 0,
        }
    }
}

impl From<crate::grid::GridCell> for Cell {
    fn from(c: crate::grid::GridCell) -> Self {
        Self {
            grapheme: c.grapheme,
            fg: c.fg,
            bg: c.bg,
            attrs: c.attrs,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
    pub cells: Vec<Cell>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: Kind,
    pub cols: u16,
    pub rows: u16,
    pub seq: u32,
    pub pane_id: [u8; 16],
    pub nrects: u32,
    pub rects: Vec<Rect>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientMsg {
    FrameAck {
        seq: u32,
    },
    Input {
        bytes: Vec<u8>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Mouse {
        x: u16,
        y: u16,
        button: u8,
        mods: u8,
        kind: u8,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("truncated frame")]
    Truncated,
    #[error("unknown frame type {0}")]
    Type(u8),
    #[error("unknown frame kind {0}")]
    Kind(u8),
    #[error("glen {0} exceeds 8")]
    Glen(u8),
}

/// Per-client skip-if-behind pump. Never queues an unbounded dirty backlog.
#[derive(Debug)]
pub struct FramePump {
    next_seq: u32,
    last_ack: u32,
    pending_dirty: Vec<Rect>,
    force_full: bool,
}

impl Default for FramePump {
    fn default() -> Self {
        Self::new()
    }
}

impl FramePump {
    pub fn new() -> Self {
        Self {
            next_seq: 1,
            last_ack: 0,
            pending_dirty: Vec::new(),
            force_full: true,
        }
    }

    pub fn ack(&mut self, seq: u32) {
        if seq > self.last_ack {
            self.last_ack = seq;
        }
    }

    pub fn behind(&self) -> bool {
        self.next_seq.saturating_sub(self.last_ack) > 1
    }

    pub fn request_full(&mut self) {
        self.force_full = true;
        self.pending_dirty.clear();
    }

    pub fn push_dirty(&mut self, rect: Rect) {
        if self.behind() {
            self.pending_dirty.clear();
            self.force_full = true;
            return;
        }
        self.pending_dirty.push(rect);
    }

    pub fn pending_dirty_len(&self) -> usize {
        self.pending_dirty.len()
    }

    pub fn take_dirty(&mut self) -> Vec<Rect> {
        std::mem::take(&mut self.pending_dirty)
    }

    /// Kind to send this tick. `None` = skip (client is behind).
    pub fn take_send(&mut self) -> Option<(u32, Kind)> {
        if self.behind() {
            self.pending_dirty.clear();
            self.force_full = true;
            return None;
        }
        let kind = if self.force_full {
            Kind::Full
        } else if !self.pending_dirty.is_empty() {
            Kind::Dirty
        } else {
            return None;
        };
        if kind == Kind::Full {
            self.pending_dirty.clear();
        }
        self.force_full = false;
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        Some((seq, kind))
    }
}

/// Last sent grid for skip/dirty. Tracks pane identity so a focus swap is a full frame.
#[derive(Debug, Default)]
pub struct FrameCache {
    last_cells: Vec<Cell>,
    last_size: (u16, u16),
    last_pane: Option<[u8; 16]>,
}

impl FrameCache {
    pub fn new() -> Self {
        Self::default()
    }
}

pub fn apply_cursor_inverse(cells: &mut [Cell], cols: u16, cursor: (u16, u16)) {
    if cols == 0 {
        return;
    }
    let i = cursor.1 as usize * cols as usize + cursor.0 as usize;
    if let Some(c) = cells.get_mut(i) {
        c.attrs ^= ATTR_INVERSE;
    }
}

pub fn compose_frame(
    pump: &mut FramePump,
    cache: &mut FrameCache,
    cols: u16,
    rows: u16,
    pane_id: [u8; 16],
    mut cells: Vec<Cell>,
    cursor: (u16, u16),
) -> Option<Vec<u8>> {
    apply_cursor_inverse(&mut cells, cols, cursor);

    if cache.last_pane != Some(pane_id) {
        pump.request_full();
        cache.last_cells.clear();
        cache.last_pane = Some(pane_id);
    }
    if (cols, rows) != cache.last_size {
        pump.request_full();
        cache.last_cells.clear();
        cache.last_size = (cols, rows);
    }
    if cells != cache.last_cells {
        if cache.last_cells.is_empty() {
            pump.request_full();
        } else {
            for rect in dirty_rects(&cache.last_cells, &cells, cols, rows) {
                pump.push_dirty(rect);
            }
        }
        cache.last_cells = cells.clone();
    }

    let (seq, kind) = pump.take_send()?;
    match kind {
        Kind::Full => Some(encode_full(cols, rows, seq, &pane_id, &cells)),
        Kind::Dirty => {
            let rects = pump.take_dirty();
            if rects.is_empty() {
                Some(encode_full(cols, rows, seq, &pane_id, &cells))
            } else {
                Some(encode_dirty(cols, rows, seq, &pane_id, &rects))
            }
        }
    }
}

pub fn encode_full(cols: u16, rows: u16, seq: u32, pane_id: &[u8; 16], cells: &[Cell]) -> Vec<u8> {
    let n = cols as usize * rows as usize;
    let mut body = cells.to_vec();
    body.resize(n, Cell::blank());
    let rect = Rect {
        x: 0,
        y: 0,
        w: cols,
        h: rows,
        cells: body,
    };
    encode_frame(Kind::Full, cols, rows, seq, pane_id, &[rect])
}

pub fn encode_dirty(cols: u16, rows: u16, seq: u32, pane_id: &[u8; 16], rects: &[Rect]) -> Vec<u8> {
    encode_frame(Kind::Dirty, cols, rows, seq, pane_id, rects)
}

fn encode_frame(
    kind: Kind,
    cols: u16,
    rows: u16,
    seq: u32,
    pane_id: &[u8; 16],
    rects: &[Rect],
) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.push(TYPE_FRAME);
    payload.push(kind as u8);
    payload.extend_from_slice(&cols.to_le_bytes());
    payload.extend_from_slice(&rows.to_le_bytes());
    payload.extend_from_slice(&seq.to_le_bytes());
    payload.extend_from_slice(pane_id);
    payload.extend_from_slice(&(rects.len() as u32).to_le_bytes());
    for rect in rects {
        payload.extend_from_slice(&rect.x.to_le_bytes());
        payload.extend_from_slice(&rect.y.to_le_bytes());
        payload.extend_from_slice(&rect.w.to_le_bytes());
        payload.extend_from_slice(&rect.h.to_le_bytes());
        let n = rect.w as usize * rect.h as usize;
        for i in 0..n {
            let cell = rect.cells.get(i).cloned().unwrap_or_else(Cell::blank);
            write_cell(&mut payload, &cell);
        }
    }
    wrap(&payload)
}

fn write_cell(out: &mut Vec<u8>, cell: &Cell) {
    let bytes = cell.grapheme.as_bytes();
    let glen = bytes.len().min(8) as u8;
    out.push(glen);
    out.extend_from_slice(&bytes[..glen as usize]);
    out.extend_from_slice(&cell.fg.to_le_bytes());
    out.extend_from_slice(&cell.bg.to_le_bytes());
    out.push(cell.attrs);
}

pub fn decode(bytes: &[u8]) -> Result<Frame, FrameError> {
    let payload = payload_of(bytes)?;
    if payload.is_empty() {
        return Err(FrameError::Truncated);
    }
    if payload[0] != TYPE_FRAME {
        return Err(FrameError::Type(payload[0]));
    }
    let mut i = 1usize;
    let kind = Kind::from_u8(*payload.get(i).ok_or(FrameError::Truncated)?)?;
    i += 1;
    let cols = u16_at(payload, &mut i)?;
    let rows = u16_at(payload, &mut i)?;
    let seq = u32_at(payload, &mut i)?;
    if i + 16 > payload.len() {
        return Err(FrameError::Truncated);
    }
    let mut pane_id = [0u8; 16];
    pane_id.copy_from_slice(&payload[i..i + 16]);
    i += 16;
    let nrects = u32_at(payload, &mut i)?;
    let mut rects = Vec::with_capacity(nrects as usize);
    for _ in 0..nrects {
        let x = u16_at(payload, &mut i)?;
        let y = u16_at(payload, &mut i)?;
        let w = u16_at(payload, &mut i)?;
        let h = u16_at(payload, &mut i)?;
        let n = w as usize * h as usize;
        let mut cells = Vec::with_capacity(n);
        for _ in 0..n {
            cells.push(read_cell(payload, &mut i)?);
        }
        rects.push(Rect { x, y, w, h, cells });
    }
    Ok(Frame {
        kind,
        cols,
        rows,
        seq,
        pane_id,
        nrects,
        rects,
    })
}

pub fn encode_ack(seq: u32) -> Vec<u8> {
    let mut payload = Vec::with_capacity(5);
    payload.push(TYPE_ACK);
    payload.extend_from_slice(&seq.to_le_bytes());
    wrap(&payload)
}

pub fn encode_input(bytes: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(5 + bytes.len());
    payload.push(TYPE_INPUT);
    payload.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    payload.extend_from_slice(bytes);
    wrap(&payload)
}

pub fn encode_resize(cols: u16, rows: u16) -> Vec<u8> {
    let mut payload = Vec::with_capacity(5);
    payload.push(TYPE_RESIZE);
    payload.extend_from_slice(&cols.to_le_bytes());
    payload.extend_from_slice(&rows.to_le_bytes());
    wrap(&payload)
}

pub fn encode_mouse(x: u16, y: u16, button: u8, mods: u8, kind: u8) -> Vec<u8> {
    let mut payload = Vec::with_capacity(8);
    payload.push(TYPE_MOUSE);
    payload.extend_from_slice(&x.to_le_bytes());
    payload.extend_from_slice(&y.to_le_bytes());
    payload.push(button);
    payload.push(mods);
    payload.push(kind);
    wrap(&payload)
}

pub fn decode_client(bytes: &[u8]) -> Result<ClientMsg, FrameError> {
    let payload = payload_of(bytes)?;
    if payload.is_empty() {
        return Err(FrameError::Truncated);
    }
    let mut i = 1usize;
    match payload[0] {
        TYPE_ACK => Ok(ClientMsg::FrameAck {
            seq: u32_at(payload, &mut i)?,
        }),
        TYPE_INPUT => {
            let n = u32_at(payload, &mut i)? as usize;
            if i + n > payload.len() {
                return Err(FrameError::Truncated);
            }
            Ok(ClientMsg::Input {
                bytes: payload[i..i + n].to_vec(),
            })
        }
        TYPE_RESIZE => {
            let cols = u16_at(payload, &mut i)?;
            let rows = u16_at(payload, &mut i)?;
            Ok(ClientMsg::Resize { cols, rows })
        }
        TYPE_MOUSE => {
            let x = u16_at(payload, &mut i)?;
            let y = u16_at(payload, &mut i)?;
            let button = *payload.get(i).ok_or(FrameError::Truncated)?;
            let mods = *payload.get(i + 1).ok_or(FrameError::Truncated)?;
            let kind = *payload.get(i + 2).ok_or(FrameError::Truncated)?;
            Ok(ClientMsg::Mouse {
                x,
                y,
                button,
                mods,
                kind,
            })
        }
        other => Err(FrameError::Type(other)),
    }
}

fn wrap(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

fn payload_of(bytes: &[u8]) -> Result<&[u8], FrameError> {
    if bytes.len() < 4 {
        return Err(FrameError::Truncated);
    }
    let len = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let rest = &bytes[4..];
    if rest.len() < len {
        return Err(FrameError::Truncated);
    }
    Ok(&rest[..len])
}

fn u16_at(buf: &[u8], i: &mut usize) -> Result<u16, FrameError> {
    let end = i.checked_add(2).ok_or(FrameError::Truncated)?;
    let slice = buf.get(*i..end).ok_or(FrameError::Truncated)?;
    *i = end;
    Ok(u16::from_le_bytes(slice.try_into().unwrap()))
}

fn u32_at(buf: &[u8], i: &mut usize) -> Result<u32, FrameError> {
    let end = i.checked_add(4).ok_or(FrameError::Truncated)?;
    let slice = buf.get(*i..end).ok_or(FrameError::Truncated)?;
    *i = end;
    Ok(u32::from_le_bytes(slice.try_into().unwrap()))
}

fn read_cell(buf: &[u8], i: &mut usize) -> Result<Cell, FrameError> {
    let glen = *buf.get(*i).ok_or(FrameError::Truncated)?;
    *i += 1;
    if glen > 8 {
        return Err(FrameError::Glen(glen));
    }
    let end = i.checked_add(glen as usize).ok_or(FrameError::Truncated)?;
    let gbytes = buf.get(*i..end).ok_or(FrameError::Truncated)?;
    *i = end;
    let grapheme = String::from_utf8_lossy(gbytes).into_owned();
    let fg = u32_at(buf, i)?;
    let bg = u32_at(buf, i)?;
    let attrs = *buf.get(*i).ok_or(FrameError::Truncated)?;
    *i += 1;
    Ok(Cell {
        grapheme,
        fg,
        bg,
        attrs,
    })
}

pub fn listen(path: &Path) -> std::io::Result<UnixListener> {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let std_l = StdUnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    std_l.set_nonblocking(true)?;
    UnixListener::from_std(std_l)
}

pub async fn read_packet<R: AsyncRead + Unpin>(reader: &mut R) -> std::io::Result<Vec<u8>> {
    let mut lenb = [0u8; 4];
    reader.read_exact(&mut lenb).await?;
    let len = u32::from_le_bytes(lenb) as usize;
    if len > 4_000_000 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).await?;
    let mut out = Vec::with_capacity(4 + len);
    out.extend_from_slice(&lenb);
    out.extend_from_slice(&payload);
    Ok(out)
}

pub async fn serve(mux: Arc<Mutex<Mux>>, client_id: String, listener: UnixListener) {
    loop {
        let gone = mux
            .lock()
            .map(|m| !m.clients.contains_key(&client_id))
            .unwrap_or(true);
        if gone {
            break;
        }
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let _ = session(&mux, &client_id, stream).await;
                        if let Ok(mut g) = mux.lock() {
                            g.detach_client(&client_id);
                        }
                        break;
                    }
                    Err(_) => break,
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
    if let Ok(g) = mux.lock() {
        let path = g.paths.frames_socket_path(&client_id);
        drop(g);
        let _ = std::fs::remove_file(path);
    }
}

async fn session(
    mux: &Arc<Mutex<Mux>>,
    client_id: &str,
    stream: tokio::net::UnixStream,
) -> std::io::Result<()> {
    let (reader, writer) = stream.into_split();
    let mut reader = reader;
    let writer = Arc::new(tokio::sync::Mutex::new(writer));
    let mut pump = FramePump::new();
    let mut cache = FrameCache::new();
    let mut interval = tokio::time::interval(Duration::from_millis(16));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = interval.tick() => {
                let gone = mux
                    .lock()
                    .map(|m| !m.clients.contains_key(client_id))
                    .unwrap_or(true);
                if gone {
                    return Ok(());
                }
                if let Some(bytes) = build_frame(mux, client_id, &mut pump, &mut cache) {
                    let mut w = writer.lock().await;
                    w.write_all(&bytes).await?;
                    w.flush().await?;
                }
            }
            pkt = read_packet(&mut reader) => {
                let pkt = pkt?;
                match decode_client(&pkt) {
                    Ok(ClientMsg::FrameAck { seq }) => pump.ack(seq),
                    Ok(ClientMsg::Input { bytes }) => {
                        let _ = mux.lock().expect("mux").client_input(client_id, &bytes);
                    }
                    Ok(ClientMsg::Resize { cols, rows }) => {
                        let _ = mux.lock().expect("mux").resize_client(client_id, cols, rows);
                        pump.request_full();
                    }
                    Ok(ClientMsg::Mouse { .. }) => {
                        // Content-region mouse is forwarded only if the pane
                        // requested tracking. Stub: off until Task 6.
                    }
                    Err(_) => {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "bad client packet",
                        ));
                    }
                }
            }
        }
    }
}

fn build_frame(
    mux: &Arc<Mutex<Mux>>,
    client_id: &str,
    pump: &mut FramePump,
    cache: &mut FrameCache,
) -> Option<Vec<u8>> {
    let (cols, rows, pane_bytes, cells, cursor) = {
        let guard = mux.lock().ok()?;
        let client = guard.clients.get(client_id)?;
        let pane_id = client.focused_pane_id.as_ref()?;
        let pane = guard.panes.get(pane_id)?;
        let grid = pane.grid.lock().ok()?;
        let (cols, rows) = grid.size();
        let cells: Vec<Cell> = grid.cells().into_iter().map(Cell::from).collect();
        let cursor = grid.cursor();
        (cols, rows, pane.id_bytes, cells, cursor)
    };
    compose_frame(pump, cache, cols, rows, pane_bytes, cells, cursor)
}

fn dirty_rects(old: &[Cell], new: &[Cell], cols: u16, rows: u16) -> Vec<Rect> {
    let cols_n = cols as usize;
    let mut rects = Vec::new();
    for y in 0..rows as usize {
        let start = y * cols_n;
        let end = start + cols_n;
        if end > old.len() || end > new.len() {
            continue;
        }
        let a = &old[start..end];
        let b = &new[start..end];
        if a == b {
            continue;
        }
        let mut x0 = 0;
        while x0 < cols_n && a[x0] == b[x0] {
            x0 += 1;
        }
        let mut x1 = cols_n;
        while x1 > x0 && a[x1 - 1] == b[x1 - 1] {
            x1 -= 1;
        }
        rects.push(Rect {
            x: x0 as u16,
            y: y as u16,
            w: (x1 - x0) as u16,
            h: 1,
            cells: b[x0..x1].to_vec(),
        });
    }
    rects
}
