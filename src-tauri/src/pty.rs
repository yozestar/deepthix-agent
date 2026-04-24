use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// A single pty: a writer (stdin) + a kill handle (Drop kills the child).
pub struct PtyHandle {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
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
        };
        self.inner.lock().unwrap().insert(id, handle);
        Ok(())
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
