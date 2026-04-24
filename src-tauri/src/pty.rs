use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// A single pty: a writer (stdin) + a kill handle (Drop kills the child).
/// `session_id` is set when the pty hosts a `claude --session-id <uuid>`
/// process so the JSONL watcher can find the transcript file.
pub struct PtyHandle {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    session_id: Option<String>,
}

impl PtyHandle {
    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        tracing::debug!(target: "deepthix::pty", bytes = data.len(), "pty write");
        self.writer.lock().unwrap().write_all(data)
    }
    pub fn resize(&self, cols: u16, rows: u16) {
        tracing::debug!(target: "deepthix::pty", cols, rows, "pty resize");
        let _ = self.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
    pub fn kill(&self) {
        tracing::info!(target: "deepthix::pty", "pty kill");
        let _ = self.child.lock().unwrap().kill();
    }
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }
}

#[derive(Default)]
pub struct TerminalManager {
    inner: Mutex<HashMap<String, PtyHandle>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Dispatches to `spawn_shell` or `spawn_claude` based on `kind`.
    pub fn spawn_with_kind<F: FnMut(&str, &[u8]) + Send + 'static>(
        &self,
        id: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        kind: &crate::commands::terminals::TerminalKind,
        on_data: F,
    ) -> std::io::Result<()> {
        match kind {
            crate::commands::terminals::TerminalKind::Shell => {
                self.spawn_shell(id, cwd, cols, rows, on_data)
            }
            crate::commands::terminals::TerminalKind::Claude => {
                self.spawn_claude(id, cwd, cols, rows, on_data)
            }
        }
    }

    /// Spawn a shell pty. The `on_data` closure is called from a background
    /// thread for each chunk read from the pty stdout/stderr.
    pub fn spawn_shell<F: FnMut(&str, &[u8]) + Send + 'static>(
        &self,
        id: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        mut on_data: F,
    ) -> std::io::Result<()> {
        tracing::info!(target: "deepthix::pty", %id, ?cwd, cols, rows, "spawn_shell");
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        tracing::debug!(target: "deepthix::pty", %shell, "resolved shell");
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let master_arc = Arc::new(Mutex::new(pair.master));

        let id_for_thread = id.clone();
        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        tracing::debug!(target: "deepthix::pty", id = %id_for_thread, "reader EOF");
                        break;
                    }
                    Ok(n) => on_data(&id_for_thread, &buf[..n]),
                    Err(e) => {
                        tracing::warn!(target: "deepthix::pty", id = %id_for_thread, error = %e, "reader err");
                        break;
                    }
                }
            }
            tracing::debug!(target: "deepthix::pty", id = %id_for_thread, "reader exit");
        });

        let handle = PtyHandle {
            writer: Arc::new(Mutex::new(writer)),
            master: master_arc,
            child: Arc::new(Mutex::new(child)),
            session_id: None,
        };
        self.inner.lock().unwrap().insert(id, handle);
        Ok(())
    }

    /// Spawn `claude --session-id <uuid>` in the given cwd. Generates a fresh
    /// UUID, registers it on the PtyHandle so the caller can query it via
    /// `get_session_id`, and starts a reader thread feeding `on_data` with the
    /// pty stdout/stderr (same protocol as `spawn_shell`).
    fn spawn_claude<F: FnMut(&str, &[u8]) + Send + 'static>(
        &self,
        id: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        mut on_data: F,
    ) -> std::io::Result<()> {
        let session_id = uuid::Uuid::new_v4().to_string();
        tracing::info!(target: "deepthix::pty", %id, ?cwd, %session_id, cols, rows, "spawn_claude");

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        // Try `claude` from PATH first; fall back to user-local install path.
        let claude_bin = if which_claude().is_some() {
            "claude".to_string()
        } else {
            let home = dirs::home_dir().unwrap_or_default();
            let fallback = home.join(".local/bin/claude");
            tracing::warn!(target: "deepthix::pty", ?fallback, "claude not on PATH, trying fallback");
            fallback.to_string_lossy().into_owned()
        };
        tracing::debug!(target: "deepthix::pty", %claude_bin, "resolved claude");

        let mut cmd = CommandBuilder::new(claude_bin);
        cmd.arg("--session-id");
        cmd.arg(&session_id);
        cmd.cwd(cwd);
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let master_arc = Arc::new(Mutex::new(pair.master));

        let id_for_thread = id.clone();
        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        tracing::debug!(target: "deepthix::pty", id = %id_for_thread, "claude reader EOF");
                        break;
                    }
                    Ok(n) => on_data(&id_for_thread, &buf[..n]),
                    Err(e) => {
                        tracing::warn!(target: "deepthix::pty", id = %id_for_thread, error = %e, "claude reader err");
                        break;
                    }
                }
            }
            tracing::debug!(target: "deepthix::pty", id = %id_for_thread, "claude reader exit");
        });

        let handle = PtyHandle {
            writer: Arc::new(Mutex::new(writer)),
            master: master_arc,
            child: Arc::new(Mutex::new(child)),
            session_id: Some(session_id),
        };
        self.inner.lock().unwrap().insert(id, handle);
        Ok(())
    }

    pub fn get_session_id(&self, id: &str) -> Option<String> {
        self.inner
            .lock()
            .unwrap()
            .get(id)
            .and_then(|h| h.session_id().map(|s| s.to_string()))
    }

    pub fn write(&self, id: &str, data: &[u8]) -> std::io::Result<()> {
        let map = self.inner.lock().unwrap();
        let handle = map
            .get(id)
            .ok_or_else(|| std::io::Error::other("no such terminal"))?;
        handle.write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(handle) = self.inner.lock().unwrap().get(id) {
            handle.resize(cols, rows);
        } else {
            tracing::warn!(target: "deepthix::pty", %id, "resize: no such terminal");
        }
    }

    pub fn kill(&self, id: &str) {
        if let Some(handle) = self.inner.lock().unwrap().remove(id) {
            handle.kill();
        } else {
            tracing::warn!(target: "deepthix::pty", %id, "kill: no such terminal");
        }
    }
}

/// Best-effort PATH lookup for `claude`. Returns Some(path) if found.
fn which_claude() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join("claude");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
