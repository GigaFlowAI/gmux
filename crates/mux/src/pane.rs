//! PTY-backed pane. Child argv, cwd, peel depth, shadow buffer.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};

use crate::grid::Grid;
use crate::session::MuxError;
use crate::shadow::Shadow;

const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn encode_crockford(bytes: &[u8]) -> String {
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut out = String::new();
    for &b in bytes {
        value = (value << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((value >> bits) & 31) as usize;
            out.push(CROCKFORD[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((value << (5 - bits)) & 31) as usize;
        out.push(CROCKFORD[idx] as char);
    }
    out
}

pub fn new_ulid(prefix: &str) -> (String, [u8; 16]) {
    let bytes = ulid::Ulid::new().to_bytes();
    (format!("{prefix}{}", encode_crockford(&bytes)), bytes)
}

pub fn new_id(prefix: &str) -> String {
    new_ulid(prefix).0
}

pub struct Pane {
    pub id: String,
    pub id_bytes: [u8; 16],
    pub tab_id: String,
    pub workspace_id: String,
    pub cwd: PathBuf,
    pub argv: Vec<String>,
    pub pid: u32,
    pub peel_depth: u32,
    pub shadow: Shadow,
    pub harness: Option<String>,
    pub session_id: Option<String>,
    pub template_id: Option<String>,
    pub grid: Arc<Mutex<Grid>>,
    /// Raw bytes last written via `write_input` / `send_keys` (tests + peel).
    pub last_input: Vec<u8>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    master: Option<Box<dyn portable_pty::MasterPty + Send>>,
}

pub struct SpawnPty {
    pub cwd: PathBuf,
    pub argv: Vec<String>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

impl Pane {
    pub fn spawn(
        id: String,
        id_bytes: [u8; 16],
        tab_id: String,
        workspace_id: String,
        peel_depth: u32,
        opts: SpawnPty,
    ) -> Result<Self, MuxError> {
        if opts.argv.is_empty() {
            return Err(MuxError::rpc(
                "invalid_request",
                "pane.spawn requires argv",
                "Pass argv, e.g. gmux spawn -- sleep 30",
            ));
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: opts.rows,
                cols: opts.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                MuxError::rpc(
                    "spawn_failed",
                    &format!("openpty failed: {e}"),
                    "Check the process ulimit for PTYs",
                )
            })?;

        let mut cmd = CommandBuilder::new(&opts.argv[0]);
        for arg in opts.argv.iter().skip(1) {
            cmd.arg(arg);
        }
        cmd.cwd(&opts.cwd);
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            MuxError::rpc(
                "spawn_failed",
                &format!("exec {:?} failed: {e}", opts.argv),
                "Check the command is on PATH",
            )
        })?;
        drop(pair.slave);

        let pid = child.process_id().unwrap_or(0);
        let reader = pair.master.try_clone_reader().map_err(|e| {
            MuxError::rpc(
                "spawn_failed",
                &format!("pty reader: {e}"),
                "Retry gmux spawn",
            )
        })?;
        let writer = pair.master.take_writer().map_err(|e| {
            MuxError::rpc(
                "spawn_failed",
                &format!("pty writer: {e}"),
                "Retry gmux spawn",
            )
        })?;

        let grid = Arc::new(Mutex::new(Grid::new(opts.cols, opts.rows)));
        let grid_reader = grid.clone();
        std::thread::Builder::new()
            .name(format!("gmux-pty-{id}"))
            .spawn(move || drain_pty(reader, grid_reader))
            .ok();

        Ok(Self {
            id,
            id_bytes,
            tab_id,
            workspace_id,
            cwd: opts.cwd,
            argv: opts.argv,
            pid,
            peel_depth,
            shadow: Shadow::new(),
            harness: None,
            session_id: None,
            template_id: None,
            grid,
            last_input: Vec::new(),
            writer: Some(writer),
            child: Some(child),
            master: Some(pair.master),
        })
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), MuxError> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if let Some(master) = self.master.as_mut() {
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| {
                    MuxError::rpc(
                        "io",
                        &format!("pty resize failed: {e}"),
                        "Retry the resize from the TUI",
                    )
                })?;
        }
        self.grid.lock().expect("grid").resize(cols, rows);
        Ok(())
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> Result<(), MuxError> {
        self.last_input.extend_from_slice(bytes);
        self.shadow.feed(bytes);
        if let Some(writer) = self.writer.as_mut() {
            writer.write_all(bytes).map_err(MuxError::from)?;
            let _ = writer.flush();
        }
        Ok(())
    }

    pub fn kill(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
        }
        self.writer.take();
        self.master.take();
        self.child.take();
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        self.kill();
    }
}

fn drain_pty(mut reader: Box<dyn std::io::Read + Send>, grid: Arc<Mutex<Grid>>) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if let Ok(mut g) = grid.lock() {
                    g.feed(&buf[..n]);
                }
            }
        }
    }
}
