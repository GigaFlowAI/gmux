//! Attach TUI: 40-col sidebar + one PTY. Prompt lives in the sidebar footer.
//! Typing from `sidebar` focuses it. Enter classifies via mux→intel; organize
//! plans confirm in the drawer. `ctrl+q` detaches without SIGHUP.

use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::mpsc;

use crate::frames::{self, Frame, Kind};
use crate::keymap::{self, Action, Mode};
use crate::paths::Paths;
use crate::sidebar::{self, Funnel, Hit, Model};

#[derive(Debug, thiserror::Error)]
pub enum TuiError {
    #[error("{message}")]
    Fail { message: String, fix: String },
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl TuiError {
    pub fn fail(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::Fail {
            message: message.into(),
            fix: fix.into(),
        }
    }

    pub fn fix(&self) -> &str {
        match self {
            Self::Fail { fix, .. } => fix,
            Self::Io(_) => "Check mux.sock is up (`gmux attach` starts gmuxd) and retry",
        }
    }
}

pub fn is_detach_key(ctrl: bool, ch: char) -> bool {
    ctrl && matches!(ch, 'q' | 'Q')
}

/// In-flight `session.snapshot` correlated by request id. Peel / focus replies
/// share the control stream and must not clear this.
#[derive(Debug, Default)]
pub(crate) struct SnapFlight {
    id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SnapOutcome {
    Ignore,
    Applied,
    Failed,
}

impl SnapFlight {
    pub(crate) fn idle(&self) -> bool {
        self.id.is_none()
    }

    pub(crate) fn sent(&mut self, id: impl Into<String>) {
        self.id = Some(id.into());
    }

    pub(crate) fn on_reply(&mut self, v: &Value) -> (SnapOutcome, Option<Value>) {
        if self.id.as_deref() != reply_id(v).as_deref() {
            return (SnapOutcome::Ignore, None);
        }
        self.id = None;
        if v.get("error").is_some() {
            return (SnapOutcome::Failed, None);
        }
        let result = v.get("result").cloned().unwrap_or(Value::Null);
        if result.get("panes").is_some() || result.get("workspaces").is_some() {
            (SnapOutcome::Applied, Some(result))
        } else {
            (SnapOutcome::Failed, None)
        }
    }
}

/// In-flight `prompt.submit` correlated by request id. Generation guard drops
/// a late classify/plan after Esc cancel.
#[derive(Debug, Default)]
struct PromptFlight {
    id: Option<String>,
    generation: u64,
}

impl PromptFlight {
    fn sent(&mut self, id: impl Into<String>, generation: u64) {
        self.id = Some(id.into());
        self.generation = generation;
    }

    fn on_reply(&mut self, v: &Value) -> Option<Value> {
        if self.id.as_deref() != reply_id(v).as_deref() {
            return None;
        }
        self.id = None;
        if v.get("error").is_some() {
            return Some(json!({ "intent": "ask" }));
        }
        Some(v.get("result").cloned().unwrap_or(Value::Null))
    }
}

fn on_prompt_reply(mode: &mut Mode, funnel: &mut Funnel, generation: u64, result: &Value) {
    if !funnel.is_current(generation) {
        return; // Esc/cancel claimed a newer generation — drop the late plan.
    }
    if result.get("intent").and_then(Value::as_str) != Some("organize") {
        return;
    }
    let Some(plan) = result.get("plan").cloned() else {
        return;
    };
    funnel.set_confirm_plan(plan);
    *mode = Mode::Confirm;
}

fn reply_id(v: &Value) -> Option<String> {
    match v.get("id") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

pub async fn run(cwd: PathBuf) -> Result<(), TuiError> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(TuiError::fail(
            "gmux attach needs a TTY",
            "Run `gmux attach` from a terminal",
        ));
    }

    let paths = Paths::from_env();
    let (term_cols, term_rows) = crossterm::terminal::size().unwrap_or((80, 24));
    let (pty_cols, pty_rows) = sidebar::pty_winsize(term_cols, term_rows);

    let control = connect_retry(&paths.socket_path()).await?;
    let (ctrl_read, mut ctrl_write) = control.into_split();
    let mut lines = BufReader::new(ctrl_read).lines();

    let attach = json!({
        "id": "1",
        "method": "client.attach",
        "params": { "cols": pty_cols, "rows": pty_rows, "cwd": cwd },
    });
    ctrl_write
        .write_all(format!("{attach}\n").as_bytes())
        .await?;
    ctrl_write.flush().await?;

    let reply = rpc_reply(&mut lines, "1").await?;
    if let Some(err) = reply.get("error") {
        return Err(TuiError::fail(
            err.get("message")
                .and_then(Value::as_str)
                .unwrap_or("attach failed"),
            err.get("fix")
                .and_then(Value::as_str)
                .unwrap_or("Check mux.sock and retry"),
        ));
    }
    let result = reply.get("result").cloned().unwrap_or(Value::Null);
    let client_id = result
        .get("clientId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            TuiError::fail(
                "attach reply missing clientId",
                "Upgrade gmuxd (`cargo build -p gmuxd`) and retry",
            )
        })?
        .to_string();
    let frames_path = result
        .get("framesSocket")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.frames_socket_path(&client_id));
    let mut focused = result
        .get("focusedPaneId")
        .and_then(Value::as_str)
        .map(str::to_string);

    let snap = rpc(
        &mut ctrl_write,
        &mut lines,
        "2",
        "session.snapshot",
        json!({}),
    )
    .await
    .unwrap_or(Value::Null);
    let ws = workspace_of(&snap, focused.as_deref());
    let mut model = Model::from_snapshot(&snap, ws.as_deref());
    model.focused_pane_id = focused.clone();
    let mut funnel = Funnel::new(model.panes.iter().map(|p| p.pane_id.clone()).collect());
    let _ = rpc(
        &mut ctrl_write,
        &mut lines,
        "3",
        "events.subscribe",
        json!({}),
    )
    .await;

    let (tx, mut ctrl_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let frames = connect_retry(&frames_path).await?;
    let (reader, writer) = frames.into_split();
    let mut reader = reader;
    let mut writer = writer;

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;
    let _restore = Restore;

    let mut mode = Mode::Pty;
    let mut last_frame: Option<Frame> = None;
    let mut next_id: u64 = 4;
    let mut last_snap = Instant::now();
    let mut snap = SnapFlight::default();
    let mut prompt = PromptFlight::default();
    let mut term_rows = term_rows;

    paint(
        &mut terminal,
        last_frame.as_ref(),
        &model,
        &funnel,
        mode,
        false,
    )?;

    loop {
        while event::poll(Duration::from_millis(0))? {
            match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => {
                    if apply_key(
                        &mut mode,
                        &mut funnel,
                        key_to_keymap(&key),
                        &key,
                        &mut ctrl_write,
                        &mut next_id,
                        &client_id,
                        &mut writer,
                        &mut prompt,
                    )
                    .await?
                    {
                        return Ok(());
                    }
                    paint(
                        &mut terminal,
                        last_frame.as_ref(),
                        &model,
                        &funnel,
                        mode,
                        false,
                    )?;
                }
                Event::Resize(c, r) => {
                    term_rows = r;
                    let (pc, pr) = sidebar::pty_winsize(c, r);
                    writer.write_all(&frames::encode_resize(pc, pr)).await?;
                    writer.flush().await?;
                    paint(
                        &mut terminal,
                        last_frame.as_ref(),
                        &model,
                        &funnel,
                        mode,
                        false,
                    )?;
                }
                Event::Mouse(mouse) => {
                    handle_mouse(
                        mouse,
                        &mut mode,
                        &mut model,
                        &mut funnel,
                        term_rows,
                        &mut ctrl_write,
                        &mut next_id,
                        &mut writer,
                    )
                    .await?;
                    if let Some(id) = model.focused_pane_id.clone() {
                        focused = Some(id);
                    }
                    paint(
                        &mut terminal,
                        last_frame.as_ref(),
                        &model,
                        &funnel,
                        mode,
                        false,
                    )?;
                }
                _ => {}
            }
        }

        tokio::select! {
            line = ctrl_rx.recv() => {
                let Some(line) = line else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v.get("event").is_some() {
                    if snap.idle() {
                        let id = send_rpc(
                            &mut ctrl_write,
                            &mut next_id,
                            "session.snapshot",
                            json!({}),
                        )
                        .await?;
                        snap.sent(id);
                    }
                    continue;
                }
                if let Some(result) = prompt.on_reply(&v) {
                    on_prompt_reply(&mut mode, &mut funnel, prompt.generation, &result);
                    paint(
                        &mut terminal,
                        last_frame.as_ref(),
                        &model,
                        &funnel,
                        mode,
                        false,
                    )?;
                    continue;
                }
                let (outcome, result) = snap.on_reply(&v);
                if let Some(result) = result {
                    apply_snapshot(
                        &mut model,
                        &mut funnel,
                        &mut mode,
                        &result,
                        focused.as_deref(),
                    );
                    last_snap = Instant::now();
                    paint(
                        &mut terminal,
                        last_frame.as_ref(),
                        &model,
                        &funnel,
                        mode,
                        false,
                    )?;
                } else if outcome == SnapOutcome::Failed {
                    last_snap = Instant::now();
                }
            }
            pkt = frames::read_packet(&mut reader) => {
                let pkt = match pkt {
                    Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
                    Err(e) => return Err(e.into()),
                    Ok(pkt) => pkt,
                };
                let frame = frames::decode(&pkt).map_err(|e| {
                    TuiError::fail(
                        format!("bad frame: {e}"),
                        "Upgrade gmuxd (`cargo build -p gmuxd`) and retry",
                    )
                })?;
                let clear = frame.kind == Kind::Full;
                writer.write_all(&frames::encode_ack(frame.seq)).await?;
                writer.flush().await?;
                last_frame = Some(frame);
                paint(
                    &mut terminal,
                    last_frame.as_ref(),
                    &model,
                    &funnel,
                    mode,
                    clear,
                )?;
            }
            _ = tokio::time::sleep(Duration::from_millis(16)) => {
                if snap.idle() && last_snap.elapsed() >= Duration::from_millis(500) {
                    let id = send_rpc(
                        &mut ctrl_write,
                        &mut next_id,
                        "session.snapshot",
                        json!({}),
                    )
                    .await?;
                    snap.sent(id);
                }
            }
        }
    }
}

/// Funnel-aware chrome dispatch. Esc collapses drawer → overview → glance
/// before leaving the sidebar. Funnel state stays client-local.
pub(crate) fn chrome_key(mode: Mode, funnel: &mut Funnel, km: keymap::Key) -> (Mode, Action) {
    if matches!(mode, Mode::Sidebar | Mode::Drawer) && km == keymap::Key::Esc {
        if funnel.esc() {
            return (Mode::Sidebar, Action::None);
        }
        return (Mode::Pty, Action::None);
    }
    let (mut next, action) = keymap::handle(mode, km);
    match action {
        Action::SelectNext => funnel.next(),
        Action::SelectPrev => funnel.prev(),
        Action::EnterDrawer => {
            funnel.enter();
            if funnel.drawer().is_none() {
                next = Mode::Sidebar;
            }
        }
        Action::StartPrompt(c) => funnel.set_pending(c),
        Action::PromptChar(c) => funnel.push_prompt(c),
        Action::PromptBackspace => funnel.backspace_prompt(),
        Action::CancelPrompt => {
            let _ = funnel.next_generation();
            funnel.clear_prompt();
            funnel.clear_confirm();
        }
        Action::ConfirmCancel => {
            let _ = funnel.next_generation();
            funnel.clear_confirm();
        }
        _ => {}
    }
    (next, action)
}

/// Returns true when the TUI should detach.
async fn apply_key(
    mode: &mut Mode,
    funnel: &mut Funnel,
    km: keymap::Key,
    key: &KeyEvent,
    ctrl_write: &mut OwnedWriteHalf,
    next_id: &mut u64,
    client_id: &str,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    prompt: &mut PromptFlight,
) -> Result<bool, TuiError> {
    let (next, action) = chrome_key(*mode, funnel, km);
    *mode = next;
    match action {
        Action::Detach => return Ok(true),
        Action::Peel => {
            send_rpc(
                ctrl_write,
                next_id,
                "peel",
                json!({ "clientId": client_id }),
            )
            .await?;
        }
        Action::Forward => {
            if let Some(bytes) = key_bytes(key) {
                writer.write_all(&frames::encode_input(&bytes)).await?;
                writer.flush().await?;
            }
        }
        Action::SubmitPrompt => {
            let text = funnel.take_prompt();
            if text.trim().is_empty() {
                return Ok(false);
            }
            let generation = funnel.next_generation();
            let id = send_rpc(
                ctrl_write,
                next_id,
                "prompt.submit",
                json!({ "prompt": text }),
            )
            .await?;
            prompt.sent(id, generation);
        }
        Action::ConfirmApply => {
            if let Some(plan) = funnel.confirm_plan().cloned() {
                send_rpc(
                    ctrl_write,
                    next_id,
                    "organize.apply",
                    json!({ "plan": plan }),
                )
                .await?;
            }
            funnel.clear_confirm();
            *mode = Mode::Sidebar;
        }
        Action::SelectNext
        | Action::SelectPrev
        | Action::EnterDrawer
        | Action::StartPrompt(_)
        | Action::PromptChar(_)
        | Action::PromptBackspace
        | Action::CancelPrompt
        | Action::ConfirmCancel
        | Action::None => {}
    }
    Ok(false)
}

/// Clicking away from Confirm cancels the plan so the preview cannot stick
/// while Esc is forwarded to a PTY.
pub(crate) fn click_away_from_confirm(mode: &mut Mode, funnel: &mut Funnel) {
    if *mode != Mode::Confirm {
        return;
    }
    let _ = funnel.next_generation();
    funnel.clear_confirm();
    *mode = Mode::Sidebar;
}

async fn handle_mouse(
    mouse: MouseEvent,
    mode: &mut Mode,
    model: &mut Model,
    funnel: &mut Funnel,
    term_rows: u16,
    ctrl_write: &mut OwnedWriteHalf,
    next_id: &mut u64,
    frames_write: &mut tokio::net::unix::OwnedWriteHalf,
) -> Result<(), TuiError> {
    let lay = sidebar::layout(model, funnel, term_rows);
    if !matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
        if matches!(
            mouse.kind,
            MouseEventKind::Down(_) | MouseEventKind::Drag(_) | MouseEventKind::Moved
        ) {
            if let Hit::Content { x, y } = sidebar::hit_layout(mouse.column, mouse.row, &lay) {
                // Stub: forward only once the pane has requested tracking.
                let _ = (x, y, frames_write);
            }
        }
        return Ok(());
    }
    click_away_from_confirm(mode, funnel);
    match sidebar::hit_layout(mouse.column, mouse.row, &lay) {
        Hit::ChromeRow(i) => {
            if let Some(pane) = model.panes.get(i) {
                let pane_id = pane.pane_id.clone();
                send_rpc(
                    ctrl_write,
                    next_id,
                    "client.focus",
                    json!({ "paneId": pane_id }),
                )
                .await?;
                model.focused_pane_id = Some(pane_id);
                *mode = Mode::Pty;
            }
        }
        Hit::Chrome => *mode = Mode::Sidebar,
        Hit::Prompt => *mode = Mode::Prompt,
        Hit::Content { .. } => {
            *mode = Mode::Pty;
        }
    }
    Ok(())
}

fn apply_snapshot(
    model: &mut Model,
    funnel: &mut Funnel,
    mode: &mut Mode,
    snap: &Value,
    focused: Option<&str>,
) {
    let ws = model
        .workspace_id
        .clone()
        .or_else(|| workspace_of(snap, focused));
    let focused_id = model.focused_pane_id.clone();
    *model = Model::from_snapshot(snap, ws.as_deref());
    model.focused_pane_id = focused_id.or_else(|| focused.map(str::to_string));
    funnel.sync_ids(model.panes.iter().map(|p| p.pane_id.clone()).collect());
    if *mode == Mode::Drawer && funnel.drawer().is_none() {
        *mode = Mode::Sidebar;
    }
}

fn workspace_of(snap: &Value, focused: Option<&str>) -> Option<String> {
    let panes = snap.get("panes")?.as_array()?;
    if let Some(id) = focused {
        if let Some(p) = panes
            .iter()
            .find(|p| p.get("paneId").and_then(Value::as_str) == Some(id))
        {
            return p
                .get("workspaceId")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
    snap.get("workspaces")
        .and_then(Value::as_array)
        .and_then(|w| w.first())
        .and_then(|w| w.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

async fn rpc(
    writer: &mut OwnedWriteHalf,
    lines: &mut tokio::io::Lines<BufReader<OwnedReadHalf>>,
    id: &str,
    method: &str,
    params: Value,
) -> Result<Value, TuiError> {
    let req = json!({ "id": id, "method": method, "params": params });
    writer.write_all(format!("{req}\n").as_bytes()).await?;
    writer.flush().await?;
    let v = rpc_reply(lines, id).await?;
    if let Some(err) = v.get("error") {
        return Err(TuiError::fail(
            err.get("message")
                .and_then(Value::as_str)
                .unwrap_or("rpc failed"),
            err.get("fix")
                .and_then(Value::as_str)
                .unwrap_or("Check mux.sock and retry"),
        ));
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

async fn rpc_reply(
    lines: &mut tokio::io::Lines<BufReader<OwnedReadHalf>>,
    id: &str,
) -> Result<Value, TuiError> {
    loop {
        let Some(line) = lines.next_line().await? else {
            return Err(TuiError::fail(
                "mux closed during RPC",
                "Restart gmuxd (`cargo run -p gmuxd`) and retry `gmux attach`",
            ));
        };
        let v: Value = serde_json::from_str(&line).map_err(|e| {
            TuiError::fail(
                format!("invalid RPC reply: {e}"),
                "Upgrade gmuxd (`cargo build -p gmuxd`) and retry",
            )
        })?;
        let matches = match v.get("id") {
            Some(Value::String(s)) => s == id,
            Some(Value::Number(n)) => n.to_string() == id,
            _ => false,
        };
        if matches {
            return Ok(v);
        }
    }
}

async fn send_rpc(
    writer: &mut OwnedWriteHalf,
    next_id: &mut u64,
    method: &str,
    params: Value,
) -> Result<String, TuiError> {
    let id = next_id.to_string();
    *next_id += 1;
    let req = json!({ "id": id, "method": method, "params": params });
    writer.write_all(format!("{req}\n").as_bytes()).await?;
    writer.flush().await?;
    Ok(id)
}

fn key_to_keymap(key: &KeyEvent) -> keymap::Key {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Char(c) if ctrl => keymap::Key::Ctrl(c),
        KeyCode::Char(c) => keymap::Key::Char(c),
        KeyCode::Esc => keymap::Key::Esc,
        KeyCode::Enter => keymap::Key::Enter,
        KeyCode::Backspace => keymap::Key::Backspace,
        KeyCode::Up => keymap::Key::Up,
        KeyCode::Down => keymap::Key::Down,
        _ => keymap::Key::Other,
    }
}

fn key_bytes(key: &KeyEvent) -> Option<Vec<u8>> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Char(c) if ctrl => {
            if is_detach_key(true, c) {
                return None;
            }
            let lower = c.to_ascii_lowercase() as u8;
            if (b'a'..=b'z').contains(&lower) {
                Some(vec![lower & 0x1f])
            } else {
                None
            }
        }
        KeyCode::Char(c) => {
            let mut buf = [0; 4];
            Some(c.encode_utf8(&mut buf).as_bytes().to_vec())
        }
        KeyCode::Enter => Some(vec![b'\r']),
        KeyCode::Backspace => Some(vec![0x7f]),
        KeyCode::Tab => Some(vec![b'\t']),
        KeyCode::Esc => Some(vec![0x1b]),
        KeyCode::Up => Some(b"\x1b[A".to_vec()),
        KeyCode::Down => Some(b"\x1b[B".to_vec()),
        KeyCode::Right => Some(b"\x1b[C".to_vec()),
        KeyCode::Left => Some(b"\x1b[D".to_vec()),
        KeyCode::Home => Some(b"\x1b[H".to_vec()),
        KeyCode::End => Some(b"\x1b[F".to_vec()),
        KeyCode::Delete => Some(b"\x1b[3~".to_vec()),
        KeyCode::PageUp => Some(b"\x1b[5~".to_vec()),
        KeyCode::PageDown => Some(b"\x1b[6~".to_vec()),
        _ => None,
    }
}

fn paint(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    frame: Option<&Frame>,
    model: &Model,
    funnel: &Funnel,
    mode: Mode,
    clear_pty: bool,
) -> io::Result<()> {
    terminal.draw(|f| {
        let area = f.area();
        let buf = f.buffer_mut();
        let side_w = sidebar::WIDTH.min(area.width);
        let pty_x = side_w;
        let pty_w = area.width.saturating_sub(side_w);
        let pty_area = Rect {
            x: pty_x,
            y: 0,
            width: pty_w,
            height: area.height,
        };
        let side_area = Rect {
            x: 0,
            y: 0,
            width: side_w,
            height: area.height,
        };

        if clear_pty {
            for y in 0..pty_area.height {
                for x in 0..pty_area.width {
                    let dest = &mut buf[(pty_area.x + x, pty_area.y + y)];
                    dest.reset();
                    dest.set_symbol(" ");
                }
            }
        }
        if let Some(frame) = frame {
            paint_pty(buf, pty_area, frame);
        }
        paint_sidebar(buf, side_area, model, funnel, mode);
    })?;
    Ok(())
}

fn paint_pty(buf: &mut ratatui::buffer::Buffer, area: Rect, frame: &Frame) {
    for rect in &frame.rects {
        for (i, cell) in rect.cells.iter().enumerate() {
            let w = rect.w.max(1);
            let x = area.x.saturating_add(rect.x.saturating_add((i as u16) % w));
            let y = area.y.saturating_add(rect.y.saturating_add((i as u16) / w));
            if x >= area.x + area.width || y >= area.y + area.height {
                continue;
            }
            let dest = &mut buf[(x, y)];
            let symbol = if cell.grapheme.is_empty() {
                " "
            } else {
                cell.grapheme.as_str()
            };
            dest.set_symbol(symbol);
            dest.set_style(
                Style::default()
                    .fg(argb(cell.fg))
                    .bg(argb(cell.bg))
                    .add_modifier(attrs(cell.attrs)),
            );
        }
    }
}

fn paint_sidebar(
    buf: &mut ratatui::buffer::Buffer,
    area: Rect,
    model: &Model,
    funnel: &Funnel,
    mode: Mode,
) {
    for y in 0..area.height {
        for x in 0..area.width {
            let dest = &mut buf[(area.x + x, area.y + y)];
            dest.reset();
            dest.set_symbol(" ");
        }
    }
    let lay = sidebar::layout(model, funnel, area.height);
    let focused = model.focused_pane_id.as_deref();
    let chrome = matches!(mode, Mode::Sidebar | Mode::Prompt | Mode::Drawer | Mode::Confirm);
    let selected = funnel.expanded();
    for (i, line) in lay.lines.iter().enumerate() {
        let y = i as u16;
        if y >= area.height {
            break;
        }
        let slot = lay.slots.get(i).copied().unwrap_or(sidebar::Slot::Empty);
        let pane_idx = match slot {
            sidebar::Slot::Pane(p) => Some(p),
            _ => None,
        };
        let is_focused_row = pane_idx
            .and_then(|p| model.panes.get(p))
            .is_some_and(|p| Some(p.pane_id.as_str()) == focused);
        let is_selected = pane_idx == selected && selected.is_some();
        let mut style = Style::default().fg(Color::Gray);
        match slot {
            sidebar::Slot::Prompt => {
                style = Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::DIM);
            }
            sidebar::Slot::Pin => {
                style = Style::default().fg(Color::Yellow);
            }
            sidebar::Slot::Pane(_) if is_selected && chrome => {
                style = Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::REVERSED);
            }
            sidebar::Slot::Pane(_) if is_focused_row => {
                style = Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::REVERSED);
            }
            sidebar::Slot::Pane(_) if chrome => {
                style = Style::default().fg(Color::White);
            }
            _ => {}
        }
        put_line(buf, area, y, line, style);
    }
}

fn put_line(buf: &mut ratatui::buffer::Buffer, area: Rect, y: u16, text: &str, style: Style) {
    buf.set_stringn(area.x, area.y + y, text, area.width as usize, style);
}

fn argb(c: u32) -> Color {
    if c & 0xFF00_0000 == 0 {
        Color::Reset
    } else {
        Color::Rgb(
            ((c >> 16) & 0xff) as u8,
            ((c >> 8) & 0xff) as u8,
            (c & 0xff) as u8,
        )
    }
}

fn attrs(bits: u8) -> Modifier {
    let mut m = Modifier::empty();
    if bits & (1 << 0) != 0 {
        m |= Modifier::BOLD;
    }
    if bits & (1 << 1) != 0 {
        m |= Modifier::DIM;
    }
    if bits & (1 << 2) != 0 {
        m |= Modifier::UNDERLINED;
    }
    if bits & (1 << 3) != 0 {
        m |= Modifier::REVERSED;
    }
    if bits & (1 << 4) != 0 {
        m |= Modifier::ITALIC;
    }
    m
}

async fn connect_retry(path: &Path) -> Result<UnixStream, TuiError> {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut last = None;
    while std::time::Instant::now() < deadline {
        match UnixStream::connect(path).await {
            Ok(s) => return Ok(s),
            Err(err) => {
                last = Some(err);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    Err(TuiError::fail(
        format!(
            "could not connect to {}: {}",
            path.display(),
            last.map(|e| e.to_string())
                .unwrap_or_else(|| "timeout".into())
        ),
        "Start gmuxd (`gmux attach` starts it) or `cargo run -p gmuxd`",
    ))
}

struct Restore;

impl Drop for Restore {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let mut stdout = io::stdout();
        let _ = execute!(stdout, DisableMouseCapture, LeaveAlternateScreen);
        let _ = stdout.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn peel_error_does_not_clear_snapshot_in_flight() {
        let mut flight = SnapFlight::default();
        flight.sent("5");
        let (outcome, result) = flight.on_reply(&json!({
            "id": "6",
            "error": {"code": "peel_bounded", "message": "bounded", "fix": "spawn"}
        }));
        assert_eq!(outcome, SnapOutcome::Ignore);
        assert!(result.is_none());
        assert!(!flight.idle());

        let (outcome, result) = flight.on_reply(&json!({
            "id": "5",
            "result": { "panes": [], "workspaces": [] }
        }));
        assert_eq!(outcome, SnapOutcome::Applied);
        assert!(result.is_some());
        assert!(flight.idle());
    }

    #[test]
    fn focus_ok_does_not_apply_as_snapshot() {
        let mut flight = SnapFlight::default();
        flight.sent("8");
        let (outcome, result) = flight.on_reply(&json!({
            "id": "7",
            "result": { "ok": true }
        }));
        assert_eq!(outcome, SnapOutcome::Ignore);
        assert!(result.is_none());
        assert!(!flight.idle());
    }

    #[test]
    fn snapshot_error_clears_in_flight_by_id() {
        let mut flight = SnapFlight::default();
        flight.sent("5");
        let (outcome, result) = flight.on_reply(&json!({
            "id": "5",
            "error": {"code": "io", "message": "mux closed", "fix": "retry"}
        }));
        assert_eq!(outcome, SnapOutcome::Failed);
        assert!(result.is_none());
        assert!(flight.idle());
    }

    #[test]
    fn esc_collapses_drawer_then_overview_then_pty() {
        let mut funnel = Funnel::new(vec!["a", "b"]);
        let mut mode = Mode::Sidebar;
        let (next, _) = chrome_key(mode, &mut funnel, keymap::Key::Char('j'));
        mode = next;
        assert_eq!(mode, Mode::Sidebar);
        assert_eq!(funnel.expanded(), Some(0));

        let (next, _) = chrome_key(mode, &mut funnel, keymap::Key::Enter);
        mode = next;
        assert_eq!(mode, Mode::Drawer);
        assert!(funnel.drawer().is_some());

        let (next, _) = chrome_key(mode, &mut funnel, keymap::Key::Esc);
        mode = next;
        assert_eq!(mode, Mode::Sidebar);
        assert!(funnel.drawer().is_none());
        assert_eq!(funnel.expanded(), Some(0));

        let (next, _) = chrome_key(mode, &mut funnel, keymap::Key::Esc);
        mode = next;
        assert_eq!(mode, Mode::Sidebar);
        assert!(funnel.expanded().is_none());

        let (next, _) = chrome_key(mode, &mut funnel, keymap::Key::Esc);
        mode = next;
        assert_eq!(mode, Mode::Pty);
    }

    #[test]
    fn printable_from_sidebar_seeds_pending_prompt() {
        let mut funnel = Funnel::new(vec!["a"]);
        let (mode, action) = chrome_key(Mode::Sidebar, &mut funnel, keymap::Key::Char('h'));
        assert_eq!(mode, Mode::Prompt);
        assert_eq!(action, Action::StartPrompt('h'));
        assert_eq!(funnel.pending_prompt(), "h");
    }

    #[test]
    fn start_prompt_replaces_pending_buffer() {
        let mut funnel = Funnel::new(vec!["a"]);
        let (mode, _) = chrome_key(Mode::Sidebar, &mut funnel, keymap::Key::Char('h'));
        assert_eq!(mode, Mode::Prompt);
        assert_eq!(funnel.pending_prompt(), "h");
        let (mode, _) = chrome_key(mode, &mut funnel, keymap::Key::Esc);
        assert_eq!(mode, Mode::Sidebar);
        let (mode, _) = chrome_key(mode, &mut funnel, keymap::Key::Char('x'));
        assert_eq!(mode, Mode::Prompt);
        assert_eq!(funnel.pending_prompt(), "x");
    }

    #[test]
    fn snapshot_remap_keeps_funnel_client_local() {
        let snap = json!({
            "intel": { "up": true },
            "panes": [
                { "paneId": "p_a", "cwd": "/tmp/a", "state": "idle" },
                { "paneId": "p_b", "cwd": "/tmp/b", "state": "idle" },
            ],
        });
        let mut model = Model::from_snapshot(&snap, None);
        let mut funnel = Funnel::new(model.panes.iter().map(|p| p.pane_id.clone()).collect());
        funnel.select(1);
        funnel.enter();
        let snap2 = json!({
            "intel": { "up": true },
            "panes": [
                { "paneId": "p_b", "cwd": "/tmp/b", "state": "idle" },
                { "paneId": "p_c", "cwd": "/tmp/c", "state": "idle" },
            ],
        });
        let mut mode = Mode::Drawer;
        apply_snapshot(&mut model, &mut funnel, &mut mode, &snap2, None);
        assert_eq!(funnel.expanded(), Some(0));
        assert_eq!(funnel.drawer(), Some(0));
        assert_eq!(mode, Mode::Drawer);
        assert_eq!(model.panes[0].pane_id, "p_b");
    }

    #[test]
    fn snapshot_drop_selected_demotes_drawer_mode() {
        let snap = json!({
            "intel": { "up": true },
            "panes": [
                { "paneId": "p_a", "cwd": "/tmp/a", "state": "idle" },
                { "paneId": "p_b", "cwd": "/tmp/b", "state": "idle" },
            ],
        });
        let mut model = Model::from_snapshot(&snap, None);
        let mut funnel = Funnel::new(model.panes.iter().map(|p| p.pane_id.clone()).collect());
        funnel.select(0);
        funnel.enter();
        let mut mode = Mode::Drawer;
        let snap2 = json!({
            "intel": { "up": true },
            "panes": [
                { "paneId": "p_b", "cwd": "/tmp/b", "state": "idle" },
            ],
        });
        apply_snapshot(&mut model, &mut funnel, &mut mode, &snap2, None);
        assert!(funnel.expanded().is_none());
        assert!(funnel.drawer().is_none());
        assert_eq!(mode, Mode::Sidebar);
    }

    #[test]
    fn prompt_typing_appends_enter_submits_esc_cancels() {
        let mut funnel = Funnel::new(vec!["a"]);
        let (mode, action) = chrome_key(Mode::Sidebar, &mut funnel, keymap::Key::Char('g'));
        assert_eq!(mode, Mode::Prompt);
        assert_eq!(action, Action::StartPrompt('g'));
        assert_eq!(funnel.pending_prompt(), "g");

        let (mode, action) = chrome_key(mode, &mut funnel, keymap::Key::Char('o'));
        assert_eq!(mode, Mode::Prompt);
        assert_eq!(action, Action::PromptChar('o'));
        assert_eq!(funnel.pending_prompt(), "go");

        let (mode, action) = chrome_key(mode, &mut funnel, keymap::Key::Enter);
        assert_eq!(mode, Mode::Prompt);
        assert_eq!(action, Action::SubmitPrompt);

        let (mode, action) = chrome_key(Mode::Prompt, &mut funnel, keymap::Key::Esc);
        assert_eq!(mode, Mode::Sidebar);
        assert_eq!(action, Action::CancelPrompt);
        assert_eq!(funnel.pending_prompt(), "");
    }

    #[test]
    fn generation_guard_drops_stale_organize_plan() {
        let mut funnel = Funnel::new(vec!["a"]);
        let generation = funnel.next_generation();
        assert!(funnel.is_current(generation));
        let _ = funnel.next_generation(); // Esc while classify/plan is in flight
        assert!(!funnel.is_current(generation));
        let mut mode = Mode::Prompt;
        on_prompt_reply(
            &mut mode,
            &mut funnel,
            generation,
            &json!({
                "intent": "organize",
                "plan": { "schemaVersion": 2, "summary": "late", "steps": [] },
            }),
        );
        assert!(funnel.confirm_plan().is_none());
        assert_eq!(mode, Mode::Prompt);
    }

    #[test]
    fn organize_reply_opens_confirm_drawer() {
        let mut funnel = Funnel::new(vec!["a"]);
        let generation = funnel.next_generation();
        let mut mode = Mode::Prompt;
        on_prompt_reply(
            &mut mode,
            &mut funnel,
            generation,
            &json!({
                "intent": "organize",
                "plan": {
                    "schemaVersion": 2,
                    "summary": "1 project tab(s), 0 pane(s) moved",
                    "steps": [],
                },
            }),
        );
        assert_eq!(mode, Mode::Confirm);
        assert!(funnel.confirm_plan().is_some());
        let (mode, action) = chrome_key(mode, &mut funnel, keymap::Key::Esc);
        assert_eq!(mode, Mode::Sidebar);
        assert_eq!(action, Action::ConfirmCancel);
        assert!(funnel.confirm_plan().is_none());
    }

    #[test]
    fn mouse_leave_confirm_cancels_plan() {
        let mut funnel = Funnel::new(vec!["a"]);
        funnel.set_confirm_plan(json!({
            "schemaVersion": 2,
            "summary": "late",
            "steps": [],
        }));
        let mut mode = Mode::Confirm;
        click_away_from_confirm(&mut mode, &mut funnel);
        assert_eq!(mode, Mode::Sidebar);
        assert!(funnel.confirm_plan().is_none());
        click_away_from_confirm(&mut mode, &mut funnel);
        assert_eq!(mode, Mode::Sidebar);
    }
}
