//! `gmuxd` — acquire the singleton lock and serve the NDJSON control socket.

use gmuxd::lock::{self, LockError};
use gmuxd::paths::Paths;
use gmuxd::protocol;

#[tokio::main]
async fn main() {
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
