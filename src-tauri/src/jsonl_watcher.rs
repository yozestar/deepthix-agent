use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const POLL_INTERVAL_MS: u64 = 500;

/// Polls a JSONL file on disk and invokes `on_line` for every newly-appended
/// line. Handles partial-line buffering for files mid-write. Stops when the
/// returned watcher is dropped.
pub struct JsonlWatcher {
    stop: Arc<Mutex<bool>>,
}

impl JsonlWatcher {
    pub fn start<F: FnMut(&str) + Send + 'static>(path: PathBuf, mut on_line: F) -> Self {
        let stop = Arc::new(Mutex::new(false));
        let stop_ref = Arc::clone(&stop);
        thread::spawn(move || {
            let mut offset: u64 = 0;
            let mut buffer = String::new();
            tracing::debug!(target: "deepthix::jsonl", ?path, "watcher started");
            loop {
                if *stop_ref.lock().unwrap() {
                    tracing::debug!(target: "deepthix::jsonl", ?path, "watcher stopped");
                    return;
                }
                if let Ok(mut file) = File::open(&path) {
                    let _ = file.seek(SeekFrom::Start(offset));
                    let mut reader = BufReader::new(&mut file);
                    let mut chunk = String::new();
                    loop {
                        chunk.clear();
                        match reader.read_line(&mut chunk) {
                            Ok(0) => break,
                            Ok(_n) => {
                                buffer.push_str(&chunk);
                                offset += chunk.len() as u64;
                                if buffer.ends_with('\n') {
                                    for line in buffer.lines() {
                                        if !line.is_empty() {
                                            tracing::trace!(target: "deepthix::jsonl", bytes = line.len(), "line emitted");
                                            on_line(line);
                                        }
                                    }
                                    buffer.clear();
                                }
                            }
                            Err(e) => {
                                tracing::warn!(target: "deepthix::jsonl", error = %e, "read_line err");
                                break;
                            }
                        }
                    }
                }
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            }
        });
        Self { stop }
    }
}

impl Drop for JsonlWatcher {
    fn drop(&mut self) {
        tracing::debug!(target: "deepthix::jsonl", "watcher dropping");
        *self.stop.lock().unwrap() = true;
    }
}

/// Computes the JSONL path Claude Code would write for this project + session.
/// Mirrors pixel-agents convention: `~/.claude/projects/<hash>/<uuid>.jsonl`
/// where `hash` = absolute project path with `/`, `\`, `:` replaced by `-`.
pub fn predict_jsonl_path(project_cwd: &std::path::Path, session_id: &str) -> PathBuf {
    let raw = project_cwd.to_string_lossy();
    // claude converts `/`, `\`, `:` AND `.` to `-` when hashing the
    // project path. Missing the `.` means we mis-predict the JSONL path
    // for any cwd containing a dot (e.g. ~/.deepthix/orchestrator) and
    // the resume code thinks the transcript doesn't exist.
    let hash: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '.' => '-',
            other => other,
        })
        .collect();
    let path = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
        .join(hash)
        .join(format!("{session_id}.jsonl"));
    tracing::debug!(target: "deepthix::jsonl", ?project_cwd, %session_id, ?path, "predicted jsonl path");
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::mpsc::channel;
    use tempfile::tempdir;

    #[test]
    fn watcher_emits_lines_as_they_arrive() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.jsonl");
        std::fs::write(&path, b"").unwrap();
        let (tx, rx) = channel::<String>();
        let _watcher = JsonlWatcher::start(path.clone(), move |line| {
            let _ = tx.send(line.to_string());
        });
        std::thread::sleep(Duration::from_millis(700));
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(f, "{{\"type\":\"hello\"}}").unwrap();
        let received = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(received.contains("hello"));
    }

    #[test]
    fn predict_jsonl_path_replaces_slashes() {
        let p = predict_jsonl_path(std::path::Path::new("/Users/x/foo"), "abc-123");
        let s = p.to_string_lossy();
        assert!(s.ends_with("-Users-x-foo/abc-123.jsonl"), "got {}", s);
    }
}
