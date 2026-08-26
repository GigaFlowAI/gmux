//! `gmuxd` — acquire the singleton lock and serve the NDJSON control socket.
//! `gmuxd attach` is the TUI client (full-bleed until Task 6).

use std::path::PathBuf;

use gmuxd::lock::{self, LockError};
use gmuxd::paths::Paths;
use gmuxd::protocol;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("attach") {
        let cwd = flag_value(&args, "--cwd")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        match gmuxd::tui::run(cwd).await {
            Ok(()) => return,
            Err(err) => {
                eprintln!("error {err}");
                eprintln!("fix   {}", err.fix());
                std::process::exit(1);
            }
        }
    }
    if matches!(args.first().map(String::as_str), Some("-h" | "--help")) {
        eprintln!("gmuxd — gmux multiplexer daemon");
        eprintln!("usage: gmuxd | gmuxd attach [--cwd DIR]");
        return;
    }
    if !args.is_empty() {
        eprintln!("error unknown command {}", args[0]);
        eprintln!("fix   gmuxd | gmuxd attach [--cwd DIR]");
        std::process::exit(1);
    }

    let paths = Paths::from_env();
    if let Err(err) = paths.ensure_dir() {
        eprintln!("error failed to create {}: {err}", paths.dir().display());
        eprintln!("fix   check XDG_CACHE_HOME / GMUX_CACHE is writable");
        std::process::exit(1);
    }

    let lock = match lock::acquire(&paths.lock_path()) {
        Ok(lock) => lock,
        Err(LockError::Held { pid, started_at }) => {
            eprintln!("error gmuxd is already running (pid {pid}, started {started_at})");
            eprintln!(
                "fix   connect to {} — a second process must not spawn gmuxd",
                paths.socket_path().display()
            );
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("error {err}");
            eprintln!(
                "fix   remove {} if the previous gmuxd crashed",
                paths.lock_path().display()
            );
            std::process::exit(1);
        }
    };

    if let Err(err) = protocol::run(paths, lock).await {
        eprintln!("error {err}");
        eprintln!("fix   check mux.sock is unused and the cache dir is writable");
        std::process::exit(1);
    }
}

fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == flag {
            return it.next().map(String::as_str);
        }
        if let Some(rest) = a.strip_prefix(&format!("{flag}=")) {
            return Some(rest);
        }
    }
    None
}
