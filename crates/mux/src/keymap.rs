//! Input-mode state machine. Funnel expansion is Task 7; prompt typing is Task 8.
//!
//! From `pty`, intercept **only** `ctrl+t`, `ctrl+g`, `ctrl+q`. `/` is forwarded.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Pty,
    Sidebar,
    Prompt,
    Drawer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Ctrl(char),
    Esc,
    Enter,
    Up,
    Down,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Detach,
    Peel,
    /// Forward the original key bytes to this client's focused PTY.
    Forward,
}

pub fn handle(mode: Mode, key: Key) -> (Mode, Action) {
    match mode {
        Mode::Pty => match key {
            Key::Ctrl('q' | 'Q') => (Mode::Pty, Action::Detach),
            Key::Ctrl('g' | 'G') => (Mode::Sidebar, Action::None),
            Key::Ctrl('t' | 'T') => (Mode::Pty, Action::Peel),
            _ => (Mode::Pty, Action::Forward),
        },
        Mode::Sidebar => match key {
            Key::Esc => (Mode::Pty, Action::None),
            Key::Ctrl('g' | 'G') => (Mode::Pty, Action::None),
            Key::Ctrl('q' | 'Q') => (Mode::Sidebar, Action::Detach),
            _ => (Mode::Sidebar, Action::None),
        },
        Mode::Prompt => match key {
            Key::Esc => (Mode::Sidebar, Action::None),
            Key::Ctrl('g' | 'G') => (Mode::Pty, Action::None),
            Key::Ctrl('q' | 'Q') => (Mode::Prompt, Action::Detach),
            _ => (Mode::Prompt, Action::None),
        },
        Mode::Drawer => match key {
            Key::Esc => (Mode::Sidebar, Action::None),
            Key::Ctrl('g' | 'G') => (Mode::Pty, Action::None),
            Key::Ctrl('q' | 'Q') => (Mode::Drawer, Action::Detach),
            _ => (Mode::Drawer, Action::None),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_ctrl_g_enters_sidebar_not_prompt() {
        assert_eq!(
            handle(Mode::Pty, Key::Ctrl('g')),
            (Mode::Sidebar, Action::None)
        );
    }

    #[test]
    fn esc_from_sidebar_returns_pty() {
        assert_eq!(handle(Mode::Sidebar, Key::Esc), (Mode::Pty, Action::None));
    }

    #[test]
    fn pty_slash_is_forward() {
        assert_eq!(
            handle(Mode::Pty, Key::Char('/')),
            (Mode::Pty, Action::Forward)
        );
    }

    #[test]
    fn pty_intercepts_only_ctrl_t_g_q() {
        assert_eq!(handle(Mode::Pty, Key::Ctrl('t')), (Mode::Pty, Action::Peel));
        assert_eq!(
            handle(Mode::Pty, Key::Ctrl('g')),
            (Mode::Sidebar, Action::None)
        );
        assert_eq!(
            handle(Mode::Pty, Key::Ctrl('q')),
            (Mode::Pty, Action::Detach)
        );
        assert_eq!(
            handle(Mode::Pty, Key::Ctrl('c')),
            (Mode::Pty, Action::Forward)
        );
        assert_eq!(
            handle(Mode::Pty, Key::Char('a')),
            (Mode::Pty, Action::Forward)
        );
        assert_eq!(handle(Mode::Pty, Key::Esc), (Mode::Pty, Action::Forward));
    }

    #[test]
    fn ctrl_g_from_sidebar_returns_pty() {
        assert_eq!(
            handle(Mode::Sidebar, Key::Ctrl('g')),
            (Mode::Pty, Action::None)
        );
    }
}
