//! Input-mode state machine. Prompt typing lives in `prompt`; confirm is a drawer.
//!
//! From `pty`, intercept **only** `ctrl+t`, `ctrl+g`, `ctrl+q`. `/` is forwarded.
//! In `sidebar`, `j`/`k` select; Enter dives; printables (including `/`) focus prompt.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Pty,
    Sidebar,
    Prompt,
    Drawer,
    Confirm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Ctrl(char),
    Esc,
    Enter,
    Backspace,
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
    SelectNext,
    SelectPrev,
    EnterDrawer,
    /// Switch to prompt and seed with this first character.
    StartPrompt(char),
    PromptChar(char),
    PromptBackspace,
    SubmitPrompt,
    CancelPrompt,
    ConfirmApply,
    ConfirmCancel,
}

/// Mirrors `src/cli/organize-confirm.ts` `confirmKey`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfirmAction {
    Apply,
    Cancel,
    Exit,
    Ignore,
}

pub fn confirm_key(key: Key) -> ConfirmAction {
    match key {
        Key::Ctrl('c' | 'd' | 'C' | 'D') => ConfirmAction::Exit,
        Key::Enter | Key::Char('y' | 'Y') => ConfirmAction::Apply,
        Key::Esc | Key::Char('n' | 'N') => ConfirmAction::Cancel,
        _ => ConfirmAction::Ignore,
    }
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
            Key::Char('j') | Key::Down => (Mode::Sidebar, Action::SelectNext),
            Key::Char('k') | Key::Up => (Mode::Sidebar, Action::SelectPrev),
            Key::Enter => (Mode::Drawer, Action::EnterDrawer),
            Key::Char(c) if !c.is_control() => (Mode::Prompt, Action::StartPrompt(c)),
            _ => (Mode::Sidebar, Action::None),
        },
        Mode::Prompt => match key {
            Key::Esc => (Mode::Sidebar, Action::CancelPrompt),
            Key::Ctrl('g' | 'G') => (Mode::Pty, Action::CancelPrompt),
            Key::Ctrl('q' | 'Q') => (Mode::Prompt, Action::Detach),
            Key::Enter => (Mode::Prompt, Action::SubmitPrompt),
            Key::Backspace => (Mode::Prompt, Action::PromptBackspace),
            Key::Char(c) if !c.is_control() => (Mode::Prompt, Action::PromptChar(c)),
            _ => (Mode::Prompt, Action::None),
        },
        Mode::Drawer => match key {
            Key::Esc => (Mode::Sidebar, Action::None),
            Key::Ctrl('g' | 'G') => (Mode::Pty, Action::None),
            Key::Ctrl('q' | 'Q') => (Mode::Drawer, Action::Detach),
            Key::Char('j' | 'k') | Key::Up | Key::Down => (Mode::Drawer, Action::None),
            Key::Char(c) if !c.is_control() => (Mode::Prompt, Action::StartPrompt(c)),
            _ => (Mode::Drawer, Action::None),
        },
        Mode::Confirm => match confirm_key(key) {
            ConfirmAction::Apply => (Mode::Confirm, Action::ConfirmApply),
            ConfirmAction::Cancel => (Mode::Sidebar, Action::ConfirmCancel),
            ConfirmAction::Exit => (Mode::Confirm, Action::Detach),
            ConfirmAction::Ignore => (Mode::Confirm, Action::None),
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
        assert_eq!(handle(Mode::Pty, Key::Ctrl('T')), (Mode::Pty, Action::Peel));
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

    #[test]
    fn sidebar_jk_select_enter_dives_printable_prompts() {
        assert_eq!(
            handle(Mode::Sidebar, Key::Char('j')),
            (Mode::Sidebar, Action::SelectNext)
        );
        assert_eq!(
            handle(Mode::Sidebar, Key::Char('k')),
            (Mode::Sidebar, Action::SelectPrev)
        );
        assert_eq!(
            handle(Mode::Sidebar, Key::Down),
            (Mode::Sidebar, Action::SelectNext)
        );
        assert_eq!(
            handle(Mode::Sidebar, Key::Up),
            (Mode::Sidebar, Action::SelectPrev)
        );
        assert_eq!(
            handle(Mode::Sidebar, Key::Enter),
            (Mode::Drawer, Action::EnterDrawer)
        );
        assert_eq!(
            handle(Mode::Sidebar, Key::Char('h')),
            (Mode::Prompt, Action::StartPrompt('h'))
        );
        assert_eq!(
            handle(Mode::Sidebar, Key::Char('/')),
            (Mode::Prompt, Action::StartPrompt('/'))
        );
        assert_eq!(
            handle(Mode::Sidebar, Key::Char(' ')),
            (Mode::Prompt, Action::StartPrompt(' '))
        );
    }

    #[test]
    fn drawer_jk_ignored_printable_prompts() {
        assert_eq!(
            handle(Mode::Drawer, Key::Char('j')),
            (Mode::Drawer, Action::None)
        );
        assert_eq!(
            handle(Mode::Drawer, Key::Char('k')),
            (Mode::Drawer, Action::None)
        );
        assert_eq!(
            handle(Mode::Drawer, Key::Char('/')),
            (Mode::Prompt, Action::StartPrompt('/'))
        );
        assert_eq!(
            handle(Mode::Drawer, Key::Esc),
            (Mode::Sidebar, Action::None)
        );
    }

    #[test]
    fn prompt_types_enter_submits_esc_cancels() {
        assert_eq!(
            handle(Mode::Prompt, Key::Char('i')),
            (Mode::Prompt, Action::PromptChar('i'))
        );
        assert_eq!(
            handle(Mode::Prompt, Key::Backspace),
            (Mode::Prompt, Action::PromptBackspace)
        );
        assert_eq!(
            handle(Mode::Prompt, Key::Enter),
            (Mode::Prompt, Action::SubmitPrompt)
        );
        assert_eq!(
            handle(Mode::Prompt, Key::Esc),
            (Mode::Sidebar, Action::CancelPrompt)
        );
    }

    #[test]
    fn confirm_enter_applies_esc_cancels() {
        assert_eq!(
            handle(Mode::Confirm, Key::Enter),
            (Mode::Confirm, Action::ConfirmApply)
        );
        assert_eq!(
            handle(Mode::Confirm, Key::Char('y')),
            (Mode::Confirm, Action::ConfirmApply)
        );
        assert_eq!(
            handle(Mode::Confirm, Key::Esc),
            (Mode::Sidebar, Action::ConfirmCancel)
        );
        assert_eq!(
            handle(Mode::Confirm, Key::Char('n')),
            (Mode::Sidebar, Action::ConfirmCancel)
        );
        assert_eq!(
            handle(Mode::Confirm, Key::Char('a')),
            (Mode::Confirm, Action::None)
        );
    }
}
