//! Always-on 40-col sidebar. Glance rows only (funnel is Task 7).
//! Prompt footer is drawn here; it is not interactive until Task 8.

use serde_json::Value;
use unicode_width::UnicodeWidthChar;

/// Left chrome width in columns. PTY winsize = term cols − this.
pub const WIDTH: u16 = 40;

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidebarPane {
    pub pane_id: String,
    pub state: String,
    pub headline: String,
    pub name: String,
    pub is_agent: bool,
    pub is_template: bool,
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
    /// Dim footer `>` — not interactive until Task 8.
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

/// Height rows, last line is the dim prompt `>`. Pins, then glance rows.
pub fn render_lines(model: &Model, height: u16) -> Vec<String> {
    let height = height.max(1) as usize;
    let width = WIDTH as usize;
    let mut lines = vec![clip_cols("", width); height];
    lines[height - 1] = clip_cols(">", width);
    if height == 1 {
        return lines;
    }
    let mut y = 0;
    for pin in &model.pins {
        if y + 1 >= height {
            break;
        }
        lines[y] = clip_cols(pin, width);
        y += 1;
    }
    for pane in &model.panes {
        if y + 1 >= height {
            break;
        }
        lines[y] = clip_cols(&pane.glance(), width);
        y += 1;
    }
    lines
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
    let headline = p
        .get("semantics")
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
        }
    }
}
