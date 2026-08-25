//! Per-pane unsubmitted-prompt shadow buffer.
//!
//! Append printables and bracketed paste. Apply Backspace / Ctrl+H / Ctrl+W /
//! Ctrl+U locally. Reset on Enter / Ctrl+M / Ctrl+J and on Ctrl+C. Ignore CSI
//! and mouse.

#[derive(Debug, Default)]
pub struct Shadow {
    buf: String,
    utf8: Vec<u8>,
    state: State,
    mouse_skip: u8,
    csi: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
    #[default]
    Ground,
    Esc,
    Csi,
    Osc,
    Ss3,
}

impl Shadow {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn as_str(&self) -> &str {
        &self.buf
    }

    pub fn clear(&mut self) {
        self.buf.clear();
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.feed_byte(b);
        }
    }

    fn feed_byte(&mut self, b: u8) {
        if self.mouse_skip > 0 {
            self.mouse_skip -= 1;
            return;
        }
        match self.state {
            State::Esc => {
                self.state = match b {
                    b'[' => State::Csi,
                    b']' | b'P' | b'X' | b'^' | b'_' => State::Osc,
                    b'O' => State::Ss3,
                    _ => State::Ground,
                };
                self.csi.clear();
                return;
            }
            State::Csi => {
                if (0x40..=0x7e).contains(&b) {
                    let is_paste_start = b == b'~' && self.csi == b"200";
                    let is_paste_end = b == b'~' && self.csi == b"201";
                    let x10_mouse = b == b'M' && self.csi.is_empty();
                    self.state = State::Ground;
                    self.csi.clear();
                    if x10_mouse {
                        self.mouse_skip = 3;
                    }
                    let _ = (is_paste_start, is_paste_end);
                    return;
                }
                if self.csi.len() < 32 {
                    self.csi.push(b);
                }
                return;
            }
            State::Osc => {
                if b == 0x07 || b == 0x9c {
                    self.state = State::Ground;
                } else if b == 0x1b {
                    self.state = State::Esc;
                }
                return;
            }
            State::Ss3 => {
                self.state = State::Ground;
                return;
            }
            State::Ground => {}
        }

        match b {
            0x1b => {
                self.flush_utf8();
                self.state = State::Esc;
            }
            0x08 | 0x7f => {
                self.flush_utf8();
                self.backspace();
            }
            0x17 => {
                self.flush_utf8();
                self.kill_word();
            }
            0x15 => {
                self.flush_utf8();
                self.buf.clear();
            }
            0x0a | 0x0d | 0x03 => {
                self.flush_utf8();
                self.buf.clear();
            }
            0x00..=0x1f => self.flush_utf8(),
            _ => self.push_utf8(b),
        }
    }

    fn push_utf8(&mut self, b: u8) {
        self.utf8.push(b);
        match std::str::from_utf8(&self.utf8) {
            Ok(s) => {
                self.buf.push_str(s);
                self.utf8.clear();
            }
            Err(err) if err.error_len().is_some() => self.utf8.clear(),
            Err(_) => {
                if self.utf8.len() > 4 {
                    self.utf8.clear();
                }
            }
        }
    }

    fn flush_utf8(&mut self) {
        self.utf8.clear();
    }

    fn backspace(&mut self) {
        self.buf.pop();
    }

    fn kill_word(&mut self) {
        let trimmed = self.buf.trim_end_matches(|c: char| c.is_whitespace());
        let cut = match trimmed.rfind(|c: char| c.is_whitespace()) {
            Some(i) => i + 1,
            None => 0,
        };
        self.buf.truncate(cut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_printables() {
        let mut s = Shadow::new();
        s.feed(b"also fix the webhook");
        assert_eq!(s.as_str(), "also fix the webhook");
    }

    #[test]
    fn backspace_and_ctrl_u_and_w() {
        let mut s = Shadow::new();
        s.feed(b"hello world");
        s.feed(&[0x08]);
        assert_eq!(s.as_str(), "hello worl");
        s.feed(&[0x17]);
        assert_eq!(s.as_str(), "hello ");
        s.feed(&[0x15]);
        assert_eq!(s.as_str(), "");
    }

    #[test]
    fn reset_on_enter_and_ctrl_c() {
        let mut s = Shadow::new();
        s.feed(b"typed\r");
        assert_eq!(s.as_str(), "");
        s.feed(b"again\x03");
        assert_eq!(s.as_str(), "");
    }

    #[test]
    fn ignores_csi_and_keeps_text() {
        let mut s = Shadow::new();
        s.feed(b"hello\x1b[31mworld");
        assert_eq!(s.as_str(), "helloworld");
    }
}
