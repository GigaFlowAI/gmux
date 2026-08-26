//! Always-on 40-col sidebar. Funnel is client-local: glance → one overview →
//! drawer. Never paints the PTY. Prompt footer is typed in `prompt` mode.

use serde_json::Value;
use unicode_width::UnicodeWidthChar;

/// Left chrome width in columns. PTY winsize = term cols − this.
pub const WIDTH: u16 = 40;

/// Client-local attention funnel. Not sent to the mux.
#[derive(Clone, Debug, Default)]
pub struct Funnel {
    ids: Vec<String>,
    selected: Option<usize>,
    drawer_open: bool,
    pending_prompt: String,
    generation: u64,
    confirm_plan: Option<Value>,
}

impl Funnel {
    pub fn new<S: Into<String>>(ids: Vec<S>) -> Self {
        Self {
            ids: ids.into_iter().map(Into::into).collect(),
            selected: None,
            drawer_open: false,
            pending_prompt: String::new(),
            generation: 0,
            confirm_plan: None,
        }
    }

    /// Expand this row (and only this row). Closes an open drawer.
    pub fn select(&mut self, i: usize) {
        if i < self.ids.len() {
            self.selected = Some(i);
            self.drawer_open = false;
        }
    }

    pub fn enter(&mut self) {
        if self.selected.is_some() {
            self.drawer_open = true;
        }
    }

    /// Close drawer, then overview. Returns true if a rung collapsed.
    pub fn esc(&mut self) -> bool {
        if self.drawer_open {
            self.drawer_open = false;
            true
        } else if self.selected.is_some() {
            self.selected = None;
            true
        } else {
            false
        }
    }

    pub fn expanded(&self) -> Option<usize> {
        self.selected
    }

    pub fn drawer(&self) -> Option<usize> {
        if self.drawer_open {
            self.selected
        } else {
            None
        }
    }

    pub fn next(&mut self) {
        if self.ids.is_empty() {
            return;
        }
        let i = match self.selected {
            None => 0,
            Some(i) => (i + 1).min(self.ids.len() - 1),
        };
        self.select(i);
    }

    pub fn prev(&mut self) {
        if self.ids.is_empty() {
            return;
        }
        let i = match self.selected {
            None => self.ids.len() - 1,
            Some(0) => 0,
            Some(i) => i - 1,
        };
        self.select(i);
    }

    pub fn pending_prompt(&self) -> &str {
        &self.pending_prompt
    }

    /// Seed the prompt buffer. Replaces, so a later StartPrompt is a new prompt.
    pub fn set_pending(&mut self, c: char) {
        self.pending_prompt.clear();
        self.pending_prompt.push(c);
    }

    pub fn push_prompt(&mut self, c: char) {
        self.pending_prompt.push(c);
    }

    pub fn backspace_prompt(&mut self) {
        self.pending_prompt.pop();
    }

    pub fn take_prompt(&mut self) -> String {
        std::mem::take(&mut self.pending_prompt)
    }

    pub fn clear_prompt(&mut self) {
        self.pending_prompt.clear();
    }

    /// Monotonic generation guard (mirrors `makeGeneration` in organize-confirm.ts).
    pub fn next_generation(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }

    pub fn is_current(&self, generation: u64) -> bool {
        generation == self.generation
    }

    pub fn set_confirm_plan(&mut self, plan: Value) {
        self.confirm_plan = Some(plan);
        self.drawer_open = true;
    }

    pub fn confirm_plan(&self) -> Option<&Value> {
        self.confirm_plan.as_ref()
    }

    pub fn clear_confirm(&mut self) {
        self.confirm_plan = None;
        self.drawer_open = false;
    }

    pub fn confirm_lines(&self, width: usize) -> Option<Vec<String>> {
        let plan = self.confirm_plan.as_ref()?;
        let mut lines = Vec::new();
        let summary = plan
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("");
        lines.push(clip_cols(summary, width));
        if let Some(steps) = plan.get("steps").and_then(Value::as_array) {
            for (i, step) in steps.iter().enumerate() {
                let desc = step
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                lines.push(clip_cols(&format!("{}. {desc}", i + 1), width));
            }
        }
        lines.push(clip_cols("", width));
        lines.push(clip_cols("[Enter] apply  [Esc] cancel", width));
        Some(lines)
    }

    /// Keep selection by pane id when the snapshot list is replaced.
    pub fn sync_ids<S: Into<String>>(&mut self, ids: Vec<S>) {
        let selected_id = self.selected.and_then(|i| self.ids.get(i).cloned());
        let drawer = self.drawer_open;
        self.ids = ids.into_iter().map(Into::into).collect();
        self.selected = selected_id.and_then(|id| self.ids.iter().position(|x| *x == id));
        self.drawer_open = self.selected.is_some() && drawer;
    }
}

/// Glyphs must match `src/cli/tmux-label.ts` `stateGlyph`.
pub fn state_glyph(state: &str) -> &'static str {
    match state {
        "working" => "●",
        "waiting" => "◔",
        "error" => "✗",
        "done" => "✓",
        "idle" => "○",
        _ => "○",
    }
}

#[derive(Clone, Debug)]
pub struct PaneRow<'a> {
    pub state: &'a str,
    pub headline: &'a str,
    pub name: &'a str,
    pub is_agent: bool,
}

pub fn glance_row(row: &PaneRow<'_>) -> String {
    format!("{} {}  {}", state_glyph(row.state), row.name, row.headline)
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct SidebarPane {
    pub pane_id: String,
    pub state: String,
    pub headline: String,
    pub name: String,
    pub is_agent: bool,
    pub is_template: bool,
    /// `summary.overview` when present; empty otherwise.
    pub overview: String,
    /// `semantics.card` fallback for the overview rung.
    pub card: String,
    pub summary: String,
    pub landed: String,
    pub open: String,
    pub next_step: String,
}

impl SidebarPane {
    pub fn overview_text(&self) -> &str {
        if !self.overview.is_empty() {
            &self.overview
        } else {
            &self.card
        }
    }
}

impl SidebarPane {
    pub fn glance(&self) -> String {
        glance_row(&PaneRow {
            state: &self.state,
            headline: &self.headline,
            name: &self.name,
            is_agent: self.is_agent,
        })
    }
}

#[derive(Clone, Debug, Default)]
pub struct Model {
    pub pins: Vec<String>,
    pub panes: Vec<SidebarPane>,
    pub intel_up: bool,
    pub focused_pane_id: Option<String>,
    pub workspace_id: Option<String>,
}

impl Model {
    pub fn from_snapshot(snap: &Value, workspace_id: Option<&str>) -> Self {
        let intel_up = snap
            .get("intel")
            .and_then(|i| i.get("up"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut pins = Vec::new();
        if !intel_up {
            pins.push("⚠ intel down".into());
        }
        if let Some(log) = snap.get("guardianLog").and_then(Value::as_array) {
            if let Some(g) = log.last() {
                if let Some(msg) = g.get("message").and_then(Value::as_str) {
                    if !msg.is_empty() {
                        pins.push(format!("⚠ {msg}"));
                    }
                }
            }
        }
        let mut panes = Vec::new();
        if let Some(arr) = snap.get("panes").and_then(Value::as_array) {
            for p in arr {
                if let Some(ws) = workspace_id {
                    if p.get("workspaceId").and_then(Value::as_str) != Some(ws) {
                        continue;
                    }
                }
                panes.push(pane_from_json(p));
            }
        }
        sort_panes(&mut panes);
        Self {
            pins,
            panes,
            intel_up,
            focused_pane_id: None,
            workspace_id: workspace_id.map(str::to_string),
        }
    }

    pub fn visible_panes(&self, height: u16) -> &[SidebarPane] {
        let budget = visible_row_budget(height, self.pins.len());
        let n = budget.min(self.panes.len());
        &self.panes[..n]
    }
}

/// Agents (`harness != null`), then templates, then idle shells.
pub fn sort_panes(panes: &mut [SidebarPane]) {
    panes.sort_by_key(|p| {
        if p.is_agent {
            0u8
        } else if p.is_template {
            1
        } else {
            2
        }
    });
}

pub fn pty_winsize(term_cols: u16, term_rows: u16) -> (u16, u16) {
    (term_cols.saturating_sub(WIDTH).max(1), term_rows.max(1))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hit {
    /// Clicked a visible glance row (index into `Model::visible_panes`).
    ChromeRow(usize),
    /// Sidebar chrome that is not a row (pins, empty space).
    Chrome,
    /// Prompt footer `>` — typed in `prompt` mode.
    Prompt,
    /// PTY content region; coords are content-relative (x already − WIDTH).
    Content { x: u16, y: u16 },
}

pub fn hit_test(
    x: u16,
    y: u16,
    term_rows: u16,
    pin_count: usize,
    visible_pane_count: usize,
) -> Hit {
    if x >= WIDTH {
        return Hit::Content {
            x: x.saturating_sub(WIDTH),
            y,
        };
    }
    if term_rows > 0 && y >= term_rows.saturating_sub(1) {
        return Hit::Prompt;
    }
    let y = y as usize;
    if y < pin_count {
        return Hit::Chrome;
    }
    let idx = y - pin_count;
    if idx < visible_pane_count {
        Hit::ChromeRow(idx)
    } else {
        Hit::Chrome
    }
}

/// One painted sidebar row. Overview/drawer lines still belong to that pane.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    Pin,
    Pane(usize),
    Empty,
    Prompt,
}

#[derive(Clone, Debug)]
pub struct Layout {
    pub lines: Vec<String>,
    pub slots: Vec<Slot>,
}

/// Height rows, last line is the dim prompt `>`. Pins, then glance rows.
/// Glance-only; pass a [`Funnel`] to [`layout`] for overview/drawer.
pub fn render_lines(model: &Model, height: u16) -> Vec<String> {
    layout(model, &Funnel::default(), height).lines
}

pub fn render(model: &Model, funnel: &Funnel, height: u16) -> Vec<String> {
    layout(model, funnel, height).lines
}

/// Pins, glance rows, at most one expanded overview, optional drawer, footer `>`.
/// Every line is clipped to [`WIDTH`] so paint cannot spill into the PTY.
pub fn layout(model: &Model, funnel: &Funnel, height: u16) -> Layout {
    let height = height.max(1) as usize;
    let width = WIDTH as usize;
    let mut lines = vec![clip_cols("", width); height];
    let mut slots = vec![Slot::Empty; height];
    let prompt = if funnel.pending_prompt().is_empty() {
        ">".to_string()
    } else {
        format!("> {}", funnel.pending_prompt())
    };
    lines[height - 1] = clip_cols(&prompt, width);
    slots[height - 1] = Slot::Prompt;
    if height == 1 {
        return Layout { lines, slots };
    }
    if let Some(confirm) = funnel.confirm_lines(width) {
        let mut y = 0;
        for line in confirm {
            if y + 1 >= height {
                break;
            }
            lines[y] = line;
            slots[y] = Slot::Pane(funnel.expanded().unwrap_or(0));
            y += 1;
        }
        return Layout { lines, slots };
    }
    let mut y = 0;
    for pin in &model.pins {
        if y + 1 >= height {
            break;
        }
        lines[y] = clip_cols(pin, width);
        slots[y] = Slot::Pin;
        y += 1;
    }
    for (idx, pane) in model.panes.iter().enumerate() {
        if y + 1 >= height {
            break;
        }
        lines[y] = clip_cols(&pane.glance(), width);
        slots[y] = Slot::Pane(idx);
        y += 1;
        if funnel.expanded() != Some(idx) {
            continue;
        }
        for line in wrap_indent(pane.overview_text(), width, 2) {
            if y + 1 >= height {
                break;
            }
            lines[y] = clip_cols(&line, width);
            slots[y] = Slot::Pane(idx);
            y += 1;
        }
        if funnel.drawer() != Some(idx) {
            continue;
        }
        for line in drawer_lines(pane, width) {
            if y + 1 >= height {
                break;
            }
            lines[y] = clip_cols(&line, width);
            slots[y] = Slot::Pane(idx);
            y += 1;
        }
    }
    Layout { lines, slots }
}

pub fn hit_layout(x: u16, y: u16, layout: &Layout) -> Hit {
    if x >= WIDTH {
        return Hit::Content {
            x: x.saturating_sub(WIDTH),
            y,
        };
    }
    match layout.slots.get(y as usize).copied().unwrap_or(Slot::Empty) {
        Slot::Prompt => Hit::Prompt,
        Slot::Pane(i) => Hit::ChromeRow(i),
        Slot::Pin | Slot::Empty => Hit::Chrome,
    }
}

fn visible_row_budget(height: u16, pin_count: usize) -> usize {
    (height as usize)
        .saturating_sub(1)
        .saturating_sub(pin_count)
}

fn pane_from_json(p: &Value) -> SidebarPane {
    let state = p
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("idle")
        .to_string();
    let semantics = p.get("semantics");
    let headline = semantics
        .and_then(|s| s.get("label"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| state.clone());
    SidebarPane {
        pane_id: p
            .get("paneId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        state,
        headline,
        name: pane_name(p),
        is_agent: p.get("harness").and_then(Value::as_str).is_some(),
        is_template: p.get("templateId").and_then(Value::as_str).is_some(),
        overview: pick_field(p, "overview"),
        card: json_str(semantics, "card"),
        summary: pick_field(p, "summary"),
        landed: pick_field(p, "landed"),
        open: pick_field(p, "open"),
        next_step: pick_field(p, "nextStep"),
    }
}

fn pick_field(p: &Value, key: &str) -> String {
    let from_summary = json_str(p.get("summary"), key);
    if !from_summary.is_empty() {
        from_summary
    } else {
        json_str(p.get("semantics"), key)
    }
}

fn json_str(obj: Option<&Value>, key: &str) -> String {
    obj.and_then(|o| o.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn drawer_lines(pane: &SidebarPane, width: usize) -> Vec<String> {
    let mut out = Vec::new();
    push_section(&mut out, "SUMMARY", &pane.summary, width);
    push_section(&mut out, "RECENT WORK", &pane.landed, width);
    push_section(&mut out, "STILL OPEN", &pane.open, width);
    push_section(&mut out, "NEXT STEP", &pane.next_step, width);
    if out.is_empty() {
        out.push("no summary yet".into());
    }
    out
}

fn push_section(out: &mut Vec<String>, label: &str, body: &str, width: usize) {
    if body.is_empty() {
        return;
    }
    out.push(label.to_string());
    out.extend(wrap_indent(body, width, 2));
}

/// Word-wrap `text` to `width − indent` display columns, then prefix indent.
fn wrap_indent(text: &str, width: usize, indent: usize) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let inner = width.saturating_sub(indent).max(1);
    let pad = " ".repeat(indent);
    wrap_cols(text, inner)
        .into_iter()
        .map(|line| format!("{pad}{line}"))
        .collect()
}

/// Greedy word wrap by display columns. Oversized words hard-split.
fn wrap_cols(input: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }
    let text = input.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut used = 0usize;
    for word in text.split(' ') {
        let w = display_cols(word);
        if line.is_empty() {
            push_word(&mut lines, &mut line, &mut used, word, w, width);
            continue;
        }
        if used + 1 + w <= width {
            line.push(' ');
            line.push_str(word);
            used += 1 + w;
        } else {
            lines.push(std::mem::take(&mut line));
            used = 0;
            push_word(&mut lines, &mut line, &mut used, word, w, width);
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

fn push_word(
    lines: &mut Vec<String>,
    line: &mut String,
    used: &mut usize,
    word: &str,
    word_cols: usize,
    width: usize,
) {
    if word_cols <= width {
        line.push_str(word);
        *used = word_cols;
        return;
    }
    for c in word.chars() {
        let cw = c.width().unwrap_or(0);
        if *used + cw > width && *used > 0 {
            lines.push(std::mem::take(line));
            *used = 0;
        }
        if cw > width {
            continue;
        }
        line.push(c);
        *used += cw;
    }
}

fn pane_name(p: &Value) -> String {
    if let Some(cwd) = p.get("cwd").and_then(Value::as_str) {
        if !cwd.is_empty() {
            if let Some(base) = std::path::Path::new(cwd)
                .file_name()
                .and_then(|s| s.to_str())
            {
                return base.to_string();
            }
        }
    }
    if let Some(argv) = p.get("argv").and_then(Value::as_array) {
        if let Some(cmd) = argv.first().and_then(Value::as_str) {
            return std::path::Path::new(cmd)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(cmd)
                .to_string();
        }
    }
    "pane".into()
}

/// Terminal display columns (East Asian Width). Matches ratatui / unicode-width.
pub fn display_cols(s: &str) -> usize {
    s.chars().map(|c| c.width().unwrap_or(0)).sum()
}

/// Clip to `width` display columns, then pad with spaces so the field is exactly
/// that wide. A trailing wide character that will not fit is dropped (one
/// column of padding instead), so the line cannot spill into the PTY.
pub fn clip_cols(s: &str, width: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for c in s.chars() {
        let w = c.width().unwrap_or(0);
        if used + w > width {
            break;
        }
        out.push(c);
        used += w;
    }
    while used < width {
        out.push(' ');
        used += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn glance_row_is_glyph_and_headline() {
        let row = glance_row(&PaneRow {
            state: "working",
            headline: "wiring checkout retry",
            name: "webshop",
            is_agent: true,
        });
        assert_eq!(row, "● webshop  wiring checkout retry");
    }

    #[test]
    fn state_glyphs_match_tmux_label() {
        assert_eq!(state_glyph("working"), "●");
        assert_eq!(state_glyph("waiting"), "◔");
        assert_eq!(state_glyph("error"), "✗");
        assert_eq!(state_glyph("done"), "✓");
        assert_eq!(state_glyph("idle"), "○");
    }

    #[test]
    fn layout_lists_agents_then_templates_then_shells() {
        let mut panes = vec![
            pane("sh", false, false),
            pane("tmpl", false, true),
            pane("agent", true, false),
            pane("sh2", false, false),
        ];
        sort_panes(&mut panes);
        let ids: Vec<&str> = panes.iter().map(|p| p.pane_id.as_str()).collect();
        assert_eq!(ids, ["agent", "tmpl", "sh", "sh2"]);

        let snap = json!({
            "intel": { "up": true },
            "panes": [
                { "paneId": "s", "cwd": "/tmp/s", "state": "idle" },
                { "paneId": "t", "cwd": "/tmp/t", "state": "idle", "templateId": "tests" },
                { "paneId": "a", "cwd": "/tmp/a", "state": "working", "harness": "claude-code" },
            ],
        });
        let ids: Vec<String> = Model::from_snapshot(&snap, None)
            .panes
            .iter()
            .map(|p| p.pane_id.clone())
            .collect();
        assert_eq!(ids, ["a", "t", "s"]);
    }

    #[test]
    fn guardian_log_pins_at_top() {
        let snap = json!({
            "intel": { "up": true },
            "guardianLog": [
                { "message": "old" },
                { "message": "pressure 91%" },
            ],
            "panes": [{
                "paneId": "p_1",
                "cwd": "/tmp/webshop",
                "state": "working",
                "harness": "claude-code",
                "semantics": { "label": "wiring checkout retry" },
            }],
        });
        let model = Model::from_snapshot(&snap, None);
        let lines = render_lines(&model, 5);
        assert_eq!(lines[0].trim_end(), "⚠ pressure 91%");
        assert_eq!(display_cols(&lines[0]), WIDTH as usize);
        assert!(lines[1].starts_with("● webshop"), "{}", lines[1]);
        assert_eq!(lines[4].trim_end(), ">");
    }

    #[test]
    fn layout_draws_prompt_footer() {
        let model = Model::default();
        let lines = render_lines(&model, 3);
        assert_eq!(lines.last().map(|s| s.trim_end()), Some(">"));
        assert_eq!(display_cols(lines.last().unwrap()), WIDTH as usize);
        assert_eq!(lines[0].trim_end(), "");
    }

    #[test]
    fn intel_down_pins_when_sidecar_is_away() {
        let snap = json!({ "intel": { "up": false }, "panes": [], "guardianLog": [] });
        let model = Model::from_snapshot(&snap, None);
        let lines = render_lines(&model, 3);
        assert_eq!(lines[0].trim_end(), "⚠ intel down");
        assert_eq!(display_cols(&lines[0]), WIDTH as usize);
        assert_eq!(lines[2].trim_end(), ">");
    }

    #[test]
    fn clip_uses_display_width_not_scalar_count() {
        // CJK ideograph is East Asian Width Wide = 2 columns.
        let wide = "全".repeat(25); // 50 columns, 25 scalars
        let line = clip_cols(&wide, 40);
        assert_eq!(display_cols(&line), 40);
        assert_eq!(line.chars().filter(|c| *c == '全').count(), 20);

        let pin = format!("⚠ {}", "x".repeat(50));
        let line = clip_cols(&pin, 40);
        assert_eq!(display_cols(&line), 40);
        assert!(
            line.chars().count() <= 40,
            "scalar count must not exceed display width"
        );
    }

    #[test]
    fn pty_winsize_is_term_minus_sidebar() {
        assert_eq!(pty_winsize(80, 24), (40, 24));
        assert_eq!(pty_winsize(40, 10), (1, 10));
        assert_eq!(pty_winsize(30, 8), (1, 8));
    }

    #[test]
    fn mouse_chrome_is_left_of_sidebar_width() {
        assert_eq!(hit_test(0, 1, 10, 0, 3), Hit::ChromeRow(1));
        assert_eq!(hit_test(39, 0, 10, 0, 3), Hit::ChromeRow(0));
        assert_eq!(hit_test(40, 3, 10, 0, 3), Hit::Content { x: 0, y: 3 });
        assert_eq!(hit_test(41, 2, 10, 0, 3), Hit::Content { x: 1, y: 2 });
        assert_eq!(hit_test(10, 9, 10, 0, 3), Hit::Prompt);
        assert_eq!(hit_test(5, 0, 10, 2, 3), Hit::Chrome);
        assert_eq!(hit_test(5, 2, 10, 2, 3), Hit::ChromeRow(0));
    }

    fn pane(id: &str, is_agent: bool, is_template: bool) -> SidebarPane {
        SidebarPane {
            pane_id: id.into(),
            state: "idle".into(),
            headline: id.into(),
            name: id.into(),
            is_agent,
            is_template,
            ..Default::default()
        }
    }

    fn agent_snap() -> Value {
        json!({
            "intel": { "up": true },
            "panes": [{
                "paneId": "p_1",
                "cwd": "/tmp/webshop",
                "state": "working",
                "harness": "claude-code",
                "semantics": {
                    "label": "wiring checkout retry",
                    "card": "fallback card text",
                },
                "summary": {
                    "overview": "Making checkout retries reliable after a queue migration.",
                    "summary": "Retry loop is in place; timestamp check is still red.",
                    "landed": "Retry loop is green.",
                    "open": "Timestamp check still red.",
                    "nextStep": "Write the timestamp test.",
                },
            }, {
                "paneId": "p_2",
                "cwd": "/tmp/billing",
                "state": "idle",
            }],
        })
    }

    #[test]
    fn only_one_row_expands() {
        let mut f = Funnel::new(vec!["a", "b"]);
        f.select(0);
        f.select(1);
        assert!(f.expanded() == Some(1));
        assert!(f.drawer().is_none());
    }

    #[test]
    fn enter_opens_drawer_esc_collapses() {
        let mut f = Funnel::new(vec!["a"]);
        f.select(0);
        f.enter();
        assert!(f.drawer().is_some());
        f.esc();
        assert!(f.drawer().is_none());
        f.esc();
        assert!(f.expanded().is_none());
    }

    #[test]
    fn expanded_overview_stays_inside_sidebar() {
        let model = Model::from_snapshot(&agent_snap(), None);
        let mut f = Funnel::new(model.panes.iter().map(|p| p.pane_id.clone()).collect());
        f.select(0);
        let lines = render(&model, &f, 10);
        assert_eq!(lines.len(), 10);
        assert!(
            lines.iter().any(|l| l.contains("queue migration")),
            "{lines:?}"
        );
        assert!(lines.iter().any(|l| l.contains("billing")), "{lines:?}");
        assert_eq!(lines.last().map(|s| s.trim_end()), Some(">"));
        for line in &lines {
            assert_eq!(display_cols(line), WIDTH as usize, "{line:?}");
        }
        // The other row is still a glance, not a second overview.
        let billing = lines.iter().find(|l| l.contains("billing")).unwrap();
        assert!(billing.contains("○"), "{billing}");
    }

    #[test]
    fn drawer_renders_summary_fields_inside_sidebar() {
        let model = Model::from_snapshot(&agent_snap(), None);
        let mut f = Funnel::new(model.panes.iter().map(|p| p.pane_id.clone()).collect());
        f.select(0);
        f.enter();
        let lines = render(&model, &f, 16);
        let joined = lines.join("\n");
        assert!(joined.contains("SUMMARY"), "{joined}");
        assert!(joined.contains("RECENT WORK"), "{joined}");
        assert!(joined.contains("STILL OPEN"), "{joined}");
        assert!(joined.contains("NEXT STEP"), "{joined}");
        assert!(joined.contains("Retry loop is in place"), "{joined}");
        assert!(joined.contains("Timestamp check still red"), "{joined}");
        assert_eq!(lines.last().map(|s| s.trim_end()), Some(">"));
        for line in &lines {
            assert_eq!(display_cols(line), WIDTH as usize, "{line:?}");
        }
    }

    #[test]
    fn overview_falls_back_to_semantics_card() {
        let snap = json!({
            "intel": { "up": true },
            "panes": [{
                "paneId": "p_1",
                "cwd": "/tmp/webshop",
                "state": "working",
                "harness": "claude-code",
                "semantics": {
                    "label": "wiring checkout retry",
                    "card": "fallback card text from intel",
                },
            }],
        });
        let model = Model::from_snapshot(&snap, None);
        let mut f = Funnel::new(vec![model.panes[0].pane_id.as_str()]);
        f.select(0);
        let lines = render(&model, &f, 6);
        assert!(
            lines
                .iter()
                .any(|l| l.contains("fallback card text from intel")),
            "{lines:?}"
        );
        for line in &lines {
            assert_eq!(display_cols(line), WIDTH as usize);
        }
    }

    #[test]
    fn hit_layout_maps_overview_lines_to_the_expanded_row() {
        let model = Model::from_snapshot(&agent_snap(), None);
        let mut f = Funnel::new(model.panes.iter().map(|p| p.pane_id.clone()).collect());
        f.select(0);
        let lay = layout(&model, &f, 10);
        assert_eq!(hit_layout(0, 0, &lay), Hit::ChromeRow(0));
        assert_eq!(hit_layout(5, 1, &lay), Hit::ChromeRow(0));
        assert_eq!(hit_layout(40, 1, &lay), Hit::Content { x: 0, y: 1 });
        assert_eq!(hit_layout(2, 9, &lay), Hit::Prompt);
    }

    #[test]
    fn prompt_footer_shows_typed_buffer() {
        let model = Model::from_snapshot(&agent_snap(), None);
        let mut f = Funnel::new(model.panes.iter().map(|p| p.pane_id.clone()).collect());
        f.set_pending('g');
        f.push_prompt('r');
        f.push_prompt('o');
        let lines = render(&model, &f, 8);
        assert_eq!(lines.last().map(|s| s.trim_end()), Some("> gro"));
        for line in &lines {
            assert_eq!(display_cols(line), WIDTH as usize, "{line:?}");
        }
    }

    #[test]
    fn confirm_drawer_shows_plan_and_hint() {
        let model = Model::from_snapshot(&agent_snap(), None);
        let mut f = Funnel::new(model.panes.iter().map(|p| p.pane_id.clone()).collect());
        f.set_confirm_plan(json!({
            "schemaVersion": 2,
            "summary": "1 project tab(s), 1 pane(s) moved",
            "steps": [{ "op": "new-tab", "description": "Create tab \"web\"" }],
        }));
        let lines = render(&model, &f, 8);
        let joined = lines.join("\n");
        assert!(joined.contains("1 project tab"), "{joined}");
        assert!(joined.contains("Create tab"), "{joined}");
        assert!(joined.contains("[Enter] apply"), "{joined}");
        assert_eq!(lines.last().map(|s| s.trim_end()), Some(">"));
    }
}
