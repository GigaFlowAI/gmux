//! Per-pane VTE grid: visible cells plus compact-line scrollback.

use std::collections::VecDeque;

use serde::Serialize;
use vte::{Params, Parser, Perform};

const SCROLLBACK_CAP: usize = 10_000;

const ATTR_BOLD: u8 = 1 << 0;
const ATTR_DIM: u8 = 1 << 1;
const ATTR_UNDERLINE: u8 = 1 << 2;
const ATTR_INVERSE: u8 = 1 << 3;
const ATTR_ITALIC: u8 = 1 << 4;

#[derive(Debug, Clone, Serialize)]
pub struct GridLine {
    pub text: String,
    pub intensity: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridSnapshot {
    pub pane_id: String,
    pub cols: u16,
    pub rows: u16,
    pub lines: Vec<GridLine>,
    pub alternate_screen: bool,
    pub foreground_command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridCell {
    pub grapheme: String,
    /// 0xAARRGGBB; AA=0 means default.
    pub fg: u32,
    pub bg: u32,
    pub attrs: u8,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Cell {
    ch: char,
    /// 0xAARRGGBB; AA=0 means default.
    fg: u32,
    bg: u32,
    attrs: u8,
}

impl Cell {
    fn empty() -> Self {
        Self {
            ch: '\0',
            fg: 0,
            bg: 0,
            attrs: 0,
        }
    }

    fn intensity(self) -> u8 {
        if self.attrs & ATTR_DIM != 0 {
            0
        } else if self.attrs & ATTR_BOLD != 0 {
            2
        } else {
            1
        }
    }

    fn display_char(self) -> char {
        if self.ch == '\0' { ' ' } else { self.ch }
    }
}

struct Screen {
    cols: usize,
    rows: usize,
    cells: Vec<Cell>,
    saved_cells: Vec<Cell>,
    alt: bool,
    cursor_x: usize,
    cursor_y: usize,
    saved_x: usize,
    saved_y: usize,
    attrs: u8,
    fg: u32,
    bg: u32,
    scrollback: VecDeque<String>,
}

pub struct Grid {
    parser: Parser,
    screen: Screen,
    generation: u64,
}

impl Grid {
    pub fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.max(1) as usize;
        let rows = rows.max(1) as usize;
        let n = cols * rows;
        Self {
            parser: Parser::new(),
            screen: Screen {
                cols,
                rows,
                cells: vec![Cell::empty(); n],
                saved_cells: vec![Cell::empty(); n],
                alt: false,
                cursor_x: 0,
                cursor_y: 0,
                saved_x: 0,
                saved_y: 0,
                attrs: 0,
                fg: 0,
                bg: 0,
                scrollback: VecDeque::new(),
            },
            generation: 0,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.screen, bytes);
        self.generation = self.generation.saturating_add(1);
    }

    pub fn size(&self) -> (u16, u16) {
        (self.screen.cols as u16, self.screen.rows as u16)
    }

    pub fn cursor(&self) -> (u16, u16) {
        (self.screen.cursor_x as u16, self.screen.cursor_y as u16)
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn cells(&self) -> Vec<GridCell> {
        self.screen
            .cells
            .iter()
            .map(|c| GridCell {
                grapheme: if c.ch == '\0' {
                    String::new()
                } else {
                    c.ch.to_string()
                },
                fg: c.fg,
                bg: c.bg,
                attrs: c.attrs,
            })
            .collect()
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(1) as usize;
        let rows = rows.max(1) as usize;
        if cols == self.screen.cols && rows == self.screen.rows {
            return;
        }
        let old_cols = self.screen.cols;
        let old_rows = self.screen.rows;
        self.screen.cells = resize_cells(&self.screen.cells, old_cols, old_rows, cols, rows);
        self.screen.saved_cells =
            resize_cells(&self.screen.saved_cells, old_cols, old_rows, cols, rows);
        self.screen.cols = cols;
        self.screen.rows = rows;
        self.screen.cursor_x = self.screen.cursor_x.min(cols.saturating_sub(1));
        self.screen.cursor_y = self.screen.cursor_y.min(rows.saturating_sub(1));
        self.screen.saved_x = self.screen.saved_x.min(cols.saturating_sub(1));
        self.screen.saved_y = self.screen.saved_y.min(rows.saturating_sub(1));
        self.generation = self.generation.saturating_add(1);
    }

    pub fn snapshot(&self, pane_id: &str, foreground_command: &str) -> GridSnapshot {
        self.snapshot_rows(pane_id, foreground_command, None)
    }

    pub fn snapshot_rows(
        &self,
        pane_id: &str,
        foreground_command: &str,
        last: Option<usize>,
    ) -> GridSnapshot {
        let mut lines: Vec<GridLine> = (0..self.screen.rows)
            .map(|y| self.screen.grid_line(y))
            .collect();
        if let Some(n) = last {
            let start = lines.len().saturating_sub(n);
            lines = lines.split_off(start);
        }
        GridSnapshot {
            pane_id: pane_id.to_string(),
            cols: self.screen.cols as u16,
            rows: self.screen.rows as u16,
            lines,
            alternate_screen: self.screen.alt,
            foreground_command: foreground_command.to_string(),
        }
    }

    pub fn read_lines(&self, n: Option<usize>) -> String {
        let len = self.screen.scrollback.len();
        let start = match n {
            Some(n) => len.saturating_sub(n),
            None => 0,
        };
        self.screen
            .scrollback
            .iter()
            .skip(start)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }
}

impl Screen {
    fn idx(&self, x: usize, y: usize) -> usize {
        y * self.cols + x
    }

    fn cell_mut(&mut self, x: usize, y: usize) -> Option<&mut Cell> {
        let i = self.idx(x, y);
        self.cells.get_mut(i)
    }

    fn grid_line(&self, y: usize) -> GridLine {
        let start = self.idx(0, y);
        let row = &self.cells[start..start + self.cols];
        let mut text = String::new();
        let mut intensity = Vec::with_capacity(self.cols);
        for cell in row {
            text.push(cell.display_char());
            intensity.push(cell.intensity());
        }
        while text.ends_with(' ') {
            text.pop();
            intensity.pop();
        }
        GridLine { text, intensity }
    }

    fn row_text(&self, y: usize) -> String {
        self.grid_line(y).text
    }

    fn push_scrollback(&mut self) {
        let line = self.row_text(self.cursor_y);
        if self.scrollback.len() >= SCROLLBACK_CAP {
            self.scrollback.pop_front();
        }
        self.scrollback.push_back(line);
    }

    fn put_char(&mut self, c: char) {
        if self.cursor_x >= self.cols {
            self.index();
            self.cursor_x = 0;
        }
        let fg = self.fg;
        let bg = self.bg;
        let attrs = self.attrs;
        if let Some(cell) = self.cell_mut(self.cursor_x, self.cursor_y) {
            *cell = Cell {
                ch: c,
                fg,
                bg,
                attrs,
            };
        }
        self.cursor_x += 1;
    }

    fn index(&mut self) {
        if self.cursor_y + 1 < self.rows {
            self.cursor_y += 1;
        } else {
            self.scroll_up();
        }
    }

    fn reverse_index(&mut self) {
        if self.cursor_y > 0 {
            self.cursor_y -= 1;
        } else {
            self.scroll_down();
        }
    }

    fn line_feed(&mut self) {
        if !self.alt {
            self.push_scrollback();
        }
        self.cursor_x = 0;
        self.index();
    }

    fn scroll_up(&mut self) {
        let cols = self.cols;
        self.cells.drain(0..cols);
        self.cells.resize(self.rows * cols, Cell::empty());
    }

    fn scroll_down(&mut self) {
        let cols = self.cols;
        self.cells
            .splice(0..0, std::iter::repeat_n(Cell::empty(), cols));
        self.cells.truncate(self.rows * cols);
    }

    fn clear_cells(&mut self, from: usize, to: usize) {
        for cell in self.cells[from..to].iter_mut() {
            *cell = Cell::empty();
        }
    }

    fn cup(&mut self, params: &Params) {
        let row = param_at(params, 0, 1).saturating_sub(1) as usize;
        let col = param_at(params, 1, 1).saturating_sub(1) as usize;
        self.cursor_y = row.min(self.rows - 1);
        self.cursor_x = col.min(self.cols - 1);
    }

    fn move_rel(&mut self, dx: i32, dy: i32) {
        let x = (self.cursor_x as i32 + dx).clamp(0, self.cols as i32 - 1) as usize;
        let y = (self.cursor_y as i32 + dy).clamp(0, self.rows as i32 - 1) as usize;
        self.cursor_x = x;
        self.cursor_y = y;
    }

    fn el(&mut self, params: &Params) {
        let mode = param_raw(params, 0);
        let y = self.cursor_y;
        let x = self.cursor_x.min(self.cols - 1);
        let start = self.idx(0, y);
        match mode {
            0 => self.clear_cells(start + x, start + self.cols),
            1 => self.clear_cells(start, start + x + 1),
            2 => self.clear_cells(start, start + self.cols),
            _ => {}
        }
    }

    fn ed(&mut self, params: &Params) {
        let mode = param_raw(params, 0);
        let i = self.idx(self.cursor_x.min(self.cols - 1), self.cursor_y);
        match mode {
            0 => self.clear_cells(i, self.cells.len()),
            1 => self.clear_cells(0, i + 1),
            2 | 3 => self.clear_cells(0, self.cells.len()),
            _ => {}
        }
    }

    fn set_alt(&mut self, enable: bool) {
        if enable == self.alt {
            return;
        }
        if enable {
            self.saved_x = self.cursor_x;
            self.saved_y = self.cursor_y;
            std::mem::swap(&mut self.cells, &mut self.saved_cells);
            self.cells.fill(Cell::empty());
            self.cursor_x = 0;
            self.cursor_y = 0;
        } else {
            std::mem::swap(&mut self.cells, &mut self.saved_cells);
            self.saved_cells.fill(Cell::empty());
            self.cursor_x = self.saved_x.min(self.cols - 1);
            self.cursor_y = self.saved_y.min(self.rows - 1);
        }
        self.alt = enable;
    }

    fn decset(&mut self, params: &Params, enable: bool) {
        for p in params.iter() {
            match p.first().copied().unwrap_or(0) {
                47 | 1047 | 1049 => self.set_alt(enable),
                1048 => {
                    if enable {
                        self.saved_x = self.cursor_x;
                        self.saved_y = self.cursor_y;
                    } else {
                        self.cursor_x = self.saved_x.min(self.cols - 1);
                        self.cursor_y = self.saved_y.min(self.rows - 1);
                    }
                }
                _ => {}
            }
        }
    }

    fn reset_attrs(&mut self) {
        self.attrs = 0;
        self.fg = 0;
        self.bg = 0;
    }

    fn sgr(&mut self, params: &Params) {
        if params.is_empty() {
            self.reset_attrs();
            return;
        }
        let mut iter = params.iter();
        while let Some(p) = iter.next() {
            let n = p.first().copied().unwrap_or(0);
            match n {
                0 => self.reset_attrs(),
                1 => self.attrs |= ATTR_BOLD,
                2 => self.attrs |= ATTR_DIM,
                3 => self.attrs |= ATTR_ITALIC,
                4 => self.attrs |= ATTR_UNDERLINE,
                7 => self.attrs |= ATTR_INVERSE,
                21 | 22 => self.attrs &= !(ATTR_BOLD | ATTR_DIM),
                23 => self.attrs &= !ATTR_ITALIC,
                24 => self.attrs &= !ATTR_UNDERLINE,
                27 => self.attrs &= !ATTR_INVERSE,
                38 | 48 => skip_color(p, &mut iter),
                _ => {}
            }
        }
    }
}

fn resize_cells(
    old: &[Cell],
    old_cols: usize,
    old_rows: usize,
    cols: usize,
    rows: usize,
) -> Vec<Cell> {
    let mut new = vec![Cell::empty(); cols * rows];
    let copy_cols = cols.min(old_cols);
    let copy_rows = rows.min(old_rows);
    for y in 0..copy_rows {
        for x in 0..copy_cols {
            let src = y * old_cols + x;
            if src < old.len() {
                new[y * cols + x] = old[src];
            }
        }
    }
    new
}

fn skip_color<'a>(p: &'a [u16], iter: &mut impl Iterator<Item = &'a [u16]>) {
    match p.get(1).copied() {
        Some(2) | Some(5) => {}
        _ => match iter.next().and_then(|x| x.first().copied()) {
            Some(2) => {
                let _ = iter.next();
                let _ = iter.next();
                let _ = iter.next();
            }
            Some(5) => {
                let _ = iter.next();
            }
            _ => {}
        },
    }
}

fn param_at(params: &Params, idx: usize, default: u16) -> u16 {
    let v = params
        .iter()
        .nth(idx)
        .and_then(|p| p.first().copied())
        .unwrap_or(0);
    if v == 0 { default } else { v }
}

fn param_raw(params: &Params, idx: usize) -> u16 {
    params
        .iter()
        .nth(idx)
        .and_then(|p| p.first().copied())
        .unwrap_or(0)
}

impl Perform for Screen {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x08 => self.cursor_x = self.cursor_x.saturating_sub(1),
            0x09 => {
                let next = ((self.cursor_x / 8) + 1) * 8;
                self.cursor_x = next.min(self.cols - 1);
            }
            0x0a | 0x0b | 0x0c => self.line_feed(),
            0x0d => self.cursor_x = 0,
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if ignore {
            return;
        }
        match (action, intermediates) {
            ('m', []) => self.sgr(params),
            ('H' | 'f', []) => self.cup(params),
            ('A', []) => self.move_rel(0, -(param_at(params, 0, 1) as i32)),
            ('B', []) => self.move_rel(0, param_at(params, 0, 1) as i32),
            ('C', []) => self.move_rel(param_at(params, 0, 1) as i32, 0),
            ('D', []) => self.move_rel(-(param_at(params, 0, 1) as i32), 0),
            ('G', []) => {
                let col = param_at(params, 0, 1).saturating_sub(1) as usize;
                self.cursor_x = col.min(self.cols - 1);
            }
            ('d', []) => {
                let row = param_at(params, 0, 1).saturating_sub(1) as usize;
                self.cursor_y = row.min(self.rows - 1);
            }
            ('J', []) => self.ed(params),
            ('K', []) => self.el(params),
            ('h', [b'?']) => self.decset(params, true),
            ('l', [b'?']) => self.decset(params, false),
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], ignore: bool, byte: u8) {
        if ignore || !intermediates.is_empty() {
            return;
        }
        match byte {
            b'7' => {
                self.saved_x = self.cursor_x;
                self.saved_y = self.cursor_y;
            }
            b'8' => {
                self.cursor_x = self.saved_x.min(self.cols - 1);
                self.cursor_y = self.saved_y.min(self.rows - 1);
            }
            b'D' => self.index(),
            b'E' => {
                self.cursor_x = 0;
                self.index();
            }
            b'M' => self.reverse_index(),
            _ => {}
        }
    }
}
