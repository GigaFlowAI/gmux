//! Singleton `mux.lock`. Second process connects; it does not spawn.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("gmuxd is already running (pid {pid}, started {started_at})")]
    Held { pid: u32, started_at: String },
    #[error("failed to acquire mux.lock: {0}")]
    Io(#[from] std::io::Error),
    #[error("mux.lock is corrupt: {0}")]
    Corrupt(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockInfo {
    #[serde(rename = "muxPid")]
    pub mux_pid: u32,
    #[serde(rename = "intelPid")]
    pub intel_pid: Option<u32>,
    #[serde(rename = "startedAt")]
    pub started_at: String,
}

/// Held `mux.lock` file. Unlinked on drop so a clean exit does not look live.
pub struct Lock {
    path: PathBuf,
    file: File,
    info: LockInfo,
}

impl Lock {
    pub fn info(&self) -> &LockInfo {
        &self.info
    }

    pub fn set_intel_pid(&mut self, pid: Option<u32>) -> Result<(), LockError> {
        self.info.intel_pid = pid;
        self.file.set_len(0)?;
        use std::io::Seek;
        self.file.seek(std::io::SeekFrom::Start(0))?;
        serde_json::to_writer(&mut self.file, &self.info)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        self.file.flush()?;
        Ok(())
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// `O_EXCL` create of `mux.lock`. Alive owner → `Held`. Dead owner → take over.
pub fn acquire(path: &Path) -> Result<Lock, LockError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    loop {
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(mut file) => {
                let info = LockInfo {
                    mux_pid: std::process::id(),
                    intel_pid: None,
                    started_at: started_at_now(),
                };
                let body = serde_json::to_vec(&info)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
                file.write_all(&body)?;
                file.flush()?;
                return Ok(Lock {
                    path: path.to_path_buf(),
                    file,
                    info,
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => match read_info(path) {
                Ok(info) if pid_alive(info.mux_pid) => {
                    return Err(LockError::Held {
                        pid: info.mux_pid,
                        started_at: info.started_at,
                    });
                }
                _ => {
                    let _ = std::fs::remove_file(path);
                }
            },
            Err(err) => return Err(err.into()),
        }
    }
}

pub fn read_info(path: &Path) -> Result<LockInfo, LockError> {
    let mut file = File::open(path)?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    serde_json::from_str(&buf).map_err(|e| LockError::Corrupt(e.to_string()))
}

pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn started_at_now() -> String {
    let mut ts: libc::time_t = 0;
    unsafe { libc::time(&mut ts) };
    let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
    unsafe { libc::gmtime_r(&ts, &mut tm) };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_lock_is_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mux.lock");
        let stale = LockInfo {
            mux_pid: 1_073_741_824,
            intel_pid: None,
            started_at: "2000-01-01T00:00:00Z".into(),
        };
        std::fs::write(&path, serde_json::to_vec(&stale).unwrap()).unwrap();
        let held = acquire(&path).unwrap();
        assert_eq!(held.info().mux_pid, std::process::id());
        drop(held);
    }
}
