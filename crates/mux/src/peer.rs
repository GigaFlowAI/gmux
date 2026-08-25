//! Peer-pid classification (macOS `LOCAL_PEERPID`, Linux `SO_PEERCRED`).
//!
//! Env is never the class. A descendant of a pane pid is always `pane` —
//! unsetting `GMUX_PANE_ID` is `permission_denied`, never promotion to `cli`.
//! TUI identifies via `client.attach` hello, not pid.

use std::os::unix::io::RawFd;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CallerClass {
    Tui,
    Intel,
    Pane,
    Cli,
}

#[derive(Debug, Clone)]
pub struct PidTree {
    pub pane_id: String,
    pub pids: Vec<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum ClassifyError {
    #[error("{message}")]
    PermissionDenied { message: String, fix: String },
}

impl ClassifyError {
    fn denied(message: &str, fix: &str) -> Self {
        Self::PermissionDenied {
            message: message.into(),
            fix: fix.into(),
        }
    }

    pub fn fix(&self) -> &str {
        match self {
            Self::PermissionDenied { fix, .. } => fix,
        }
    }
}

/// Pure classifier. `intel_pid` is `mux.lock`'s `intelPid`.
///
/// Order (spec §11, TUI-by-hello override from Task 2):
/// 1. `peer_pid` matches intel sidecar pid **and** token ok → `intel`.
///    Token without pid match, or pid match without token → `permission_denied`.
/// 2. `peer_pid` is in a pane process tree → `pane`. Missing/mismatch
///    `GMUX_PANE_ID` → `permission_denied`, **never** `cli`.
/// 3. Else same-uid (socket is 0600) → `cli`.
pub fn classify(
    peer_pid: u32,
    pane_pids: &[PidTree],
    has_token: bool,
    env_pane_id: Option<&str>,
    intel_pid: Option<u32>,
) -> Result<CallerClass, ClassifyError> {
    if peer_pid == 0 {
        return Err(ClassifyError::denied(
            "peer pid unknown",
            "Refuse the connection — unknown pid is not cli",
        ));
    }
    if intel_pid == Some(peer_pid) {
        if has_token {
            return Ok(CallerClass::Intel);
        }
        return Err(ClassifyError::denied(
            "intel pid presented without intel.token",
            "Pass the token minted at intel.token on hello",
        ));
    }
    if has_token {
        return Err(ClassifyError::denied(
            "intel.token did not match the intel sidecar pid",
            "Only the sidecar process may present intel.token",
        ));
    }

    if let Some(tree) = pane_pids.iter().find(|t| t.pids.contains(&peer_pid)) {
        match env_pane_id {
            Some(id) if id == tree.pane_id => return Ok(CallerClass::Pane),
            Some(_) => {
                return Err(ClassifyError::denied(
                    "GMUX_PANE_ID does not match the pane process tree",
                    "Unset GMUX_PANE_ID cannot escape the pane class; call from the pane that owns the pid",
                ));
            }
            None => {
                return Err(ClassifyError::denied(
                    "pane process is missing GMUX_PANE_ID",
                    "A descendant of a pane pid is always pane — unsetting GMUX_PANE_ID is permission_denied, never cli",
                ));
            }
        }
    }

    Ok(CallerClass::Cli)
}

/// `client.attach` is TUI hello. A pane descendant stays `pane`.
pub fn may_attach(class: CallerClass) -> bool {
    matches!(class, CallerClass::Cli | CallerClass::Tui)
}

/// Intel `hello`: token + pid. First hello (no `intelPid` yet) may mint the
/// peer pid only for a non-pane caller. Later hellos must match the minted pid.
/// Token without pid match is `permission_denied`.
pub fn intel_hello(
    presented_token: &str,
    expected_token: &str,
    peer_pid: u32,
    intel_pid: Option<u32>,
    caller: Option<CallerClass>,
) -> Result<u32, ClassifyError> {
    if presented_token.is_empty() || presented_token != expected_token {
        return Err(ClassifyError::denied(
            "intel hello token mismatch",
            "Read intel.token (mode 0600) minted by gmuxd",
        ));
    }
    if peer_pid == 0 {
        return Err(ClassifyError::denied(
            "peer pid unknown",
            "Refuse the connection — unknown pid is not cli",
        ));
    }
    match intel_pid {
        Some(pid) if pid == peer_pid => Ok(pid),
        Some(_) => Err(ClassifyError::denied(
            "intel.token did not match the intel sidecar pid",
            "Only the sidecar process may present intel.token",
        )),
        None => match caller {
            Some(CallerClass::Cli) | Some(CallerClass::Tui) => Ok(peer_pid),
            _ => Err(ClassifyError::denied(
                "intel.token did not match the intel sidecar pid",
                "Only the sidecar process may present intel.token",
            )),
        },
    }
}

/// macOS `LOCAL_PEERPID` (`0x002` / `sys/un.h`).
#[cfg(target_os = "macos")]
const LOCAL_PEERPID: libc::c_int = 0x002;
#[cfg(target_os = "macos")]
const LOCAL_PEEREPID: libc::c_int = 0x003;
#[cfg(target_os = "macos")]
const SOL_LOCAL: libc::c_int = 0;

#[cfg(target_os = "macos")]
pub fn peer_pid(fd: RawFd) -> std::io::Result<u32> {
    match getsockopt_pid(fd, LOCAL_PEERPID) {
        Ok(pid) if pid != 0 => Ok(pid),
        _ => getsockopt_pid(fd, LOCAL_PEEREPID),
    }
}

#[cfg(target_os = "macos")]
fn getsockopt_pid(fd: RawFd, opt: libc::c_int) -> std::io::Result<u32> {
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            fd,
            SOL_LOCAL,
            opt,
            &mut pid as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(pid as u32)
}

#[cfg(target_os = "linux")]
pub fn peer_pid(fd: RawFd) -> std::io::Result<u32> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(cred.pid as u32)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn peer_pid(_fd: RawFd) -> std::io::Result<u32> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "peer pid is only implemented on macOS and Linux",
    ))
}

/// Best-effort `GMUX_PANE_ID` of `pid`. Missing is a deny for pane-tree pids.
pub fn env_var_of(pid: u32, key: &str) -> Option<String> {
    read_environ(pid).and_then(|pairs| pairs.into_iter().find_map(|(k, v)| (k == key).then_some(v)))
}

#[cfg(target_os = "linux")]
fn read_environ(pid: u32) -> Option<Vec<(String, String)>> {
    let bytes = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    Some(parse_env_block(&bytes))
}

#[cfg(target_os = "macos")]
fn read_environ(pid: u32) -> Option<Vec<(String, String)>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    let mut size = 0usize;
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size];
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    buf.truncate(size);
    parse_procargs2(&buf)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_environ(_pid: u32) -> Option<Vec<(String, String)>> {
    None
}

#[cfg(target_os = "macos")]
fn parse_procargs2(buf: &[u8]) -> Option<Vec<(String, String)>> {
    if buf.len() < 4 {
        return None;
    }
    let argc = i32::from_ne_bytes(buf[0..4].try_into().ok()?);
    if argc < 0 {
        return None;
    }
    let mut i = 4;
    while i < buf.len() && buf[i] != 0 {
        i += 1;
    }
    i += 1;
    while i < buf.len() && buf[i] == 0 {
        i += 1;
    }
    for _ in 0..argc {
        while i < buf.len() && buf[i] != 0 {
            i += 1;
        }
        i += 1;
    }
    Some(parse_env_block(&buf[i.min(buf.len())..]))
}

fn parse_env_block(bytes: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for chunk in bytes.split(|b| *b == 0) {
        if chunk.is_empty() {
            continue;
        }
        let s = String::from_utf8_lossy(chunk);
        if let Some((k, v)) = s.split_once('=') {
            out.push((k.to_string(), v.to_string()));
        }
    }
    out
}

/// Live process tree of `root` (root + descendants) via `ps`. Refresh is best-effort.
pub fn tree_pids(root: u32) -> Vec<u32> {
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid,ppid"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines().skip(1) {
            let mut parts = line.split_whitespace();
            let Some(pid) = parts.next().and_then(|s| s.parse().ok()) else {
                continue;
            };
            let Some(ppid) = parts.next().and_then(|s| s.parse().ok()) else {
                continue;
            };
            children.entry(ppid).or_default().push(pid);
        }
    }
    let mut stack = vec![root];
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        out.push(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids);
        }
    }
    out
}
