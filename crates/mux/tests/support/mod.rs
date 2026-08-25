//! In-process gmuxd harness for peel_without_intel (and lock tests that need a live mux).

use std::sync::{Arc, Mutex};

use gmuxd::lock::Lock;
use gmuxd::paths::Paths;
use gmuxd::session::{Mux, MuxError, SpawnOpts, Spawned, TabSpec};

pub struct Harness {
    mux: Arc<Mutex<Mux>>,
    _dir: tempfile::TempDir,
    _lock: Lock,
}

pub async fn start() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::from_dir(dir.path());
    paths.ensure_dir().unwrap();
    let lock = gmuxd::lock::acquire(&paths.lock_path()).unwrap();
    let mut mux = Mux::new(paths, "test-token".into());
    mux.cached_harness_argv = Some(vec!["/bin/sleep".into(), "30".into()]);
    Harness {
        mux: Arc::new(Mutex::new(mux)),
        _dir: dir,
        _lock: lock,
    }
}

impl Harness {
    pub async fn spawn_shell(&self, cwd: &str) -> Spawned {
        self.mux
            .lock()
            .unwrap()
            .spawn(SpawnOpts {
                cwd: cwd.into(),
                argv: vec!["/bin/sleep".into(), "30".into()],
                env: Default::default(),
                tab: TabSpec::New {
                    name: "main".into(),
                },
                focus: false,
                peel_depth: 0,
                client_id: None,
                workspace_id: None,
            })
            .unwrap()
    }

    pub fn set_client_focus(&self, client_id: &str, pane_id: &str) {
        self.mux
            .lock()
            .unwrap()
            .set_client_focus(client_id, pane_id);
    }

    pub async fn write_input(&self, pane_id: &str, bytes: &[u8]) {
        self.mux
            .lock()
            .unwrap()
            .write_input(pane_id, bytes)
            .unwrap();
    }

    pub async fn peel(&self, client_id: &str) -> Result<Spawned, MuxError> {
        gmuxd::peel::peel(&mut self.mux.lock().unwrap(), client_id)
    }

    pub async fn peel_from_pane(&self, pane_id: &str) -> Result<Spawned, MuxError> {
        gmuxd::peel::peel_from_pane(&mut self.mux.lock().unwrap(), pane_id, None)
    }

    pub fn focused(&self, client_id: &str) -> String {
        self.mux
            .lock()
            .unwrap()
            .focused(client_id)
            .unwrap()
            .to_string()
    }
}
