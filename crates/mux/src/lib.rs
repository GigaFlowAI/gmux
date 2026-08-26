//! gmux multiplexer (`gmuxd`): PTYs, VTE grid, control socket, attach TUI.

pub mod frames;
pub mod grid;
pub mod keymap;
pub mod lock;
pub mod pane;
pub mod paths;
pub mod peel;
pub mod peer;
pub mod protocol;
pub mod session;
pub mod shadow;
pub mod sidebar;
pub mod tui;
