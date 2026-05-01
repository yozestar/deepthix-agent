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
    /// `skip_permissions` is forwarded to claude as `--dangerously-skip-permissions`.
    /// `resume_session_id` is used as `--session-id` (claude resumes from the
    /// existing JSONL transcript if it exists); when None, a fresh UUID is generated.
    pub fn spawn_with_kind<F: FnMut(&str, &[u8]) + Send + 'static>(
        &self,
        id: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        kind: &crate::commands::terminals::TerminalKind,
        skip_permissions: bool,
        resume_session_id: Option<String>,
        on_data: F,
    ) -> std::io::Result<()> {
        match kind {
            crate::commands::terminals::TerminalKind::Shell => {
                self.spawn_shell(id, cwd, cols, rows, on_data)
            }
            crate::commands::terminals::TerminalKind::Claude => {
                self.spawn_claude(id, cwd, cols, rows, skip_permissions, resume_session_id, on_data)
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
        skip_permissions: bool,
        resume_session_id: Option<String>,
        mut on_data: F,
    ) -> std::io::Result<()> {
        let mut resuming = resume_session_id.is_some();
        let session_id = resume_session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        // If the caller asked us to resume but the JSONL transcript file
        // doesn't exist on disk, claude exits immediately with "No
        // conversation found with session ID …". This typically happens when
        // the user closes the app before claude has flushed any output: we
        // persisted the session UUID but the transcript file was never
        // created. In that case, fall back to spawning a brand-new session
        // under the SAME UUID via `--session-id`, so the persisted identifier
        // remains stable for future resumes.
        if resuming {
            let predicted = crate::jsonl_watcher::predict_jsonl_path(&cwd, &session_id);
            if !predicted.exists() {
                tracing::info!(
                    target: "deepthix::pty",
                    %id, %session_id, ?predicted,
                    "no JSONL on disk for resume target; falling back to fresh --session-id"
                );
                resuming = false;
            }
        }

        tracing::info!(target: "deepthix::pty", %id, ?cwd, %session_id, cols, rows, skip_permissions, resuming, "spawn_claude");

        // Claude creates ~/.claude/session-env/<uuid>/ as a lock per
        // session. When we respawn (resume OR fresh --session-id with a
        // recycled UUID) the previous lock can survive the prior host
        // process exit and claude refuses to start with "Session ID is
        // already in use". Always nuke it before spawn — claude
        // recreates whatever it needs at startup.
        if let Some(home) = dirs::home_dir() {
            let lock = home.join(".claude").join("session-env").join(&session_id);
            if lock.exists() {
                match std::fs::remove_dir_all(&lock) {
                    Ok(()) => tracing::debug!(target: "deepthix::pty", ?lock, "removed stale session lock"),
                    Err(e) => tracing::warn!(target: "deepthix::pty", ?lock, error = %e, "failed to remove stale session lock"),
                }
            }
        }

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
        if resuming {
            // Re-attach to an existing transcript.
            cmd.arg("--resume");
            cmd.arg(&session_id);
        } else {
            // Fresh session under a known UUID (so we can resume later).
            cmd.arg("--session-id");
            cmd.arg(&session_id);
        }
        if skip_permissions {
            cmd.arg("--dangerously-skip-permissions");
        }
        // Pass our overlay settings so claude pipes its rate_limits JSON
        // to our snapshot dumper script via statusLine, AND pass
        // --mcp-config so claude spawns the deepthix MCP sidecar (read
        // tools for the orchestrator). Both files are installed by
        // ensure_installed(); best-effort if install failed.
        match crate::commands::usage_snapshot::ensure_installed() {
            Ok(()) => {
                if let Ok(overlay) = crate::commands::usage_snapshot::overlay_settings_path() {
                    let overlay_str = overlay.to_string_lossy().into_owned();
                    tracing::debug!(target: "deepthix::pty", %overlay_str, "passing --settings overlay");
                    cmd.arg("--settings");
                    cmd.arg(&overlay_str);
                }
                if let Ok(mcp) = crate::commands::usage_snapshot::mcp_config_path() {
                    if mcp.exists() {
                        let mcp_str = mcp.to_string_lossy().into_owned();
                        tracing::debug!(target: "deepthix::pty", %mcp_str, "passing --mcp-config");
                        cmd.arg("--mcp-config");
                        cmd.arg(&mcp_str);
                    }
                }
            }
            Err(e) => {
                tracing::warn!(target: "deepthix::pty", error = %e, "usage_snapshot install failed; spawning claude without overlay");
            }
        }
        cmd.cwd(&cwd);
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }

        // Expose the project-level dashboard path so claude can write to it
        // without the user copy/pasting from the OVERVIEW pane. Was per-
        // session before; now one shared file per project so multiple
        // sessions in the same project collaborate on a single status
        // board (matches the new OverviewPane behaviour).
        let project_id = crate::state::project_id_for_path(&cwd);
        if let Ok(home) = std::env::var("HOME") {
            let dashboard_path = std::path::PathBuf::from(home)
                .join(".deepthix")
                .join("projects")
                .join(&project_id)
                .join("dashboard.html");
            if let Some(parent) = dashboard_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let dashboard_path_str = dashboard_path.to_string_lossy().into_owned();
            tracing::debug!(
                target: "deepthix::pty",
                %id, %session_id, %dashboard_path_str,
                "injecting DEEPTHIX_DASHBOARD_PATH (project-level)",
            );
            cmd.env("DEEPTHIX_DASHBOARD_PATH", dashboard_path_str);
            cmd.env("DEEPTHIX_SESSION_ID", &session_id);
            cmd.env("DEEPTHIX_PROJECT_ID", &project_id);
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

    /// Find a live terminal id whose hosted claude session matches the
    /// supplied session UUID. Used by the scheduler to deliver a job
    /// prompt to the right pty: the on-disk schedule references the
    /// stable session_id, but ptyWrite needs the in-memory term id
    /// (assigned anew on each spawn). Returns None if no terminal
    /// currently hosts that session.
    pub fn find_term_by_session(&self, session_id: &str) -> Option<String> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .find_map(|(term_id, handle)| {
                if handle.session_id() == Some(session_id) {
                    Some(term_id.clone())
                } else {
                    None
                }
            })
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
