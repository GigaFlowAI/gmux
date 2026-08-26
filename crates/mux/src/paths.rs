//! On-disk names under `~/.cache/gmux/gmux/` (honours `XDG_CACHE_HOME` / `GMUX_CACHE`).

use std::path::{Path, PathBuf};

/// Directory that holds `mux.sock`, `mux.lock`, `intel.token`.
#[derive(Debug, Clone)]
pub struct Paths {
    dir: PathBuf,
}

impl Paths {
    /// `dir` is the gmux dir (`…/gmux/gmux`), not the cache root.
    pub fn from_dir(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Production: `$XDG_CACHE_HOME/gmux/gmux` or `~/.cache/gmux/gmux`.
    /// Tests: `GMUX_CACHE` is the gmux dir itself (contains `mux.sock`).
    pub fn from_env() -> Self {
        if let Ok(dir) = std::env::var("GMUX_CACHE") {
            let dir = dir.trim();
            if !dir.is_empty() {
                return Self::from_dir(dir);
            }
        }
        let cache_root = match std::env::var("XDG_CACHE_HOME") {
            Ok(xdg) if !xdg.trim().is_empty() => PathBuf::from(xdg).join("gmux"),
            _ => home_dir().join(".cache").join("gmux"),
        };
        Self::from_dir(cache_root.join("gmux"))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn ensure_dir(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)
    }

    pub fn socket_path(&self) -> PathBuf {
        self.dir.join("mux.sock")
    }

    pub fn lock_path(&self) -> PathBuf {
        self.dir.join("mux.lock")
    }

    pub fn intel_token_path(&self) -> PathBuf {
        self.dir.join("intel.token")
    }

    pub fn frames_socket_path(&self, client_id: &str) -> PathBuf {
        self.dir.join(format!("mux.frames.{client_id}.sock"))
    }
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}
