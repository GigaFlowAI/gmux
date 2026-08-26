//! Full-bleed attach TUI. Content region = the whole terminal (no sidebar yet).
//! `ctrl+q` detaches without SIGHUP. SIGWINCH → Resize for this client.

use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::style::{Color, Modifier, Style};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::frames::{self, Frame, Kind};
use crate::paths::Paths;

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

pub async fn run(cwd: PathBuf) -> Result<(), TuiError> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(TuiError::fail(
            "gmux attach needs a TTY",
            "Run `gmux attach` from a terminal",
        ));
    }

    let paths = Paths::from_env();
    let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));

    let mut control = connect_retry(&paths.socket_path()).await?;
    let attach = json!({
        "id": "1",
        "method": "client.attach",
        "params": { "cols": cols, "rows": rows, "cwd": cwd },
    });
    control.write_all(format!("{attach}\n").as_bytes()).await?;
    control.flush().await?;

    let mut lines = BufReader::new(control).lines();
    let Some(line) = lines.next_line().await? else {
        return Err(TuiError::fail(
            "mux closed during client.attach",
            "Restart gmuxd (`cargo run -p gmuxd`) and retry `gmux attach`",
        ));
    };
    let reply: Value = serde_json::from_str(&line).map_err(|e| {
        TuiError::fail(
            format!("invalid attach reply: {e}"),
            "Upgrade gmuxd (`cargo build -p gmuxd`) and retry",
        )
    })?;
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
        })?;
    let frames_path = result
        .get("framesSocket")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.frames_socket_path(client_id));

    let frames = connect_retry(&frames_path).await?;
    let (reader, writer) = frames.into_split();
    let mut reader = reader;
    let mut writer = writer;

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;
    let _restore = Restore;

    // Keep `lines` (control socket) alive so detach is disconnect, not pane kill.
    let _control = lines;

    loop {
        while event::poll(Duration::from_millis(0))? {
            match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => {
                    if key_is_detach(&key) {
                        return Ok(());
                    }
                    if let Some(bytes) = key_bytes(&key) {
                        writer.write_all(&frames::encode_input(&bytes)).await?;
                        writer.flush().await?;
                    }
                }
                Event::Resize(c, r) => {
                    writer.write_all(&frames::encode_resize(c, r)).await?;
                    writer.flush().await?;
                }
                _ => {}
            }
        }

        tokio::select! {
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
                paint(&mut terminal, &frame)?;
                writer.write_all(&frames::encode_ack(frame.seq)).await?;
                writer.flush().await?;
            }
            _ = tokio::time::sleep(Duration::from_millis(16)) => {}
        }
    }
}

fn key_is_detach(key: &KeyEvent) -> bool {
    is_detach_key(
        key.modifiers.contains(KeyModifiers::CONTROL),
        match key.code {
            KeyCode::Char(c) => c,
            _ => return false,
        },
    )
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

fn paint(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>, frame: &Frame) -> io::Result<()> {
    terminal.draw(|f| {
        let area = f.area();
        let buf = f.buffer_mut();
        if frame.kind == Kind::Full {
            for y in 0..area.height {
                for x in 0..area.width {
                    buf[(x, y)].reset();
                    buf[(x, y)].set_symbol(" ");
                }
            }
        }
        for rect in &frame.rects {
            for (i, cell) in rect.cells.iter().enumerate() {
                let w = rect.w.max(1);
                let x = rect.x.saturating_add((i as u16) % w);
                let y = rect.y.saturating_add((i as u16) / w);
                if x >= area.width || y >= area.height {
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
    })?;
    Ok(())
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
        let _ = execute!(stdout, LeaveAlternateScreen);
        let _ = stdout.flush();
    }
}
