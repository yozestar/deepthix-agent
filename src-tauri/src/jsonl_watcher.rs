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
/// Mirrors pixel-agents convention: `~/.claude/projects/<hash>/<uuid>.jsonl`.
///
/// Claude Code's hash rule (verified against `~/.claude/projects/` on a
/// real Windows install): replace any non-alphanumeric ASCII char that
/// isn't `-` with `-`. So `/`, `\`, `:`, `.`, `_`, ` ` (space), and any
/// accented/non-ASCII char all collapse to `-`. Empirically:
///
///   `C:\Claude\claude_agent`         -> `C--Claude-claude-agent`
///   `C:\Claude\Récupération de…`     -> `C--Claude-R-cup-ration-de-…`
///
/// The previous implementation only converted `/`, `\`, `:`, `.`. Every
/// project path containing `_` or a space mis-predicted the hash and the
/// resume code silently saw "no history" because the wrong directory
/// was queried.
pub fn predict_jsonl_path(project_cwd: &std::path::Path, session_id: &str) -> PathBuf {
    let raw = project_cwd.to_string_lossy();
    // Strip Windows extended-length path prefixes (`\\?\` and `\\?\UNC\`).
    // Tauri / `std::fs::canonicalize` hand back paths in this verbatim form
    // (e.g. `\\?\C:\Claude\claude_agent`), but Claude Code hashes the
    // user-facing path (`C:\Claude\claude_agent`). Without stripping, a
    // verbatim-prefixed cwd hashes to `----C--Claude-claude-agent` and we
    // miss the on-disk dir entirely — manifests as "session reopened but
    // empty transcript" because chat_load_history returns Ok(vec![]).
    let trimmed = raw
        .strip_prefix(r"\\?\UNC\")
        .map(|s| format!(r"\\{}", s))
        .or_else(|| raw.strip_prefix(r"\\?\").map(|s| s.to_string()))
        .unwrap_or_else(|| raw.to_string());
    let hash: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    // Defense in depth: a session_id arriving from the JS side with a
    // path separator or a Windows-invalid char (`<>"|?*` / control / NUL)
    // would land us with a malformed final path and `read_to_string`
    // returns ERROR_INVALID_NAME (os error 123) on Windows — which
    // surfaces in the UI as the cryptic "read jsonl: La syntaxe du nom
    // de fichier est incorrecte". UUIDs from claude don't have these
    // chars, but we sanitize anyway so a stale or hand-edited
    // session_id can never produce error 123.
    let safe_session_id: String = session_id
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0' => '-',
            c if c.is_control() => '-',
            other => other,
        })
        .collect();
    let path = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
        .join(hash)
        .join(format!("{safe_session_id}.jsonl"));
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
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("-Users-x-foo/abc-123.jsonl"), "got {}", s);
    }

    #[test]
    fn predict_jsonl_path_collapses_underscore_and_space() {
        // Matches the actual on-disk dir for `C:\Claude\claude_agent` =
        // `C--Claude-claude-agent` and for paths containing spaces.
        let p = predict_jsonl_path(
            std::path::Path::new("C:\\Claude\\claude_agent"),
            "0bd378fb-e286-46ef-8642-54db1d27a4e2",
        );
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(
            s.contains("/C--Claude-claude-agent/"),
            "underscore should collapse to dash, got {}",
            s,
        );
        let p2 = predict_jsonl_path(std::path::Path::new("/Users/x/My Project"), "sid");
        let s2 = p2.to_string_lossy().replace('\\', "/");
        assert!(
            s2.contains("/-Users-x-My-Project/"),
            "space should collapse to dash, got {}",
            s2,
        );
    }

    #[test]
    fn predict_jsonl_path_strips_verbatim_prefix() {
        // Tauri/canonicalize hand back `\\?\C:\…` — must hash to the same
        // dir as the user-facing `C:\…` form, otherwise reopened sessions
        // show an empty transcript.
        let with = predict_jsonl_path(
            std::path::Path::new(r"\\?\C:\Claude\claude_agent"),
            "abc",
        );
        let without = predict_jsonl_path(
            std::path::Path::new(r"C:\Claude\claude_agent"),
            "abc",
        );
        assert_eq!(with, without);
        let s = with.to_string_lossy().replace('\\', "/");
        assert!(
            s.contains("/C--Claude-claude-agent/"),
            "verbatim prefix should not leak into hash, got {}",
            s,
        );
    }

    #[test]
    fn predict_jsonl_path_strips_verbatim_unc_prefix() {
        // UNC verbatim form: `\\?\UNC\server\share\…` -> `\\server\share\…`.
        let p = predict_jsonl_path(
            std::path::Path::new(r"\\?\UNC\server\share\proj"),
            "abc",
        );
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(
            s.contains("/--server-share-proj/"),
            "UNC prefix should map to leading `\\\\` then dash, got {}",
            s,
        );
    }

    #[test]
    fn predict_jsonl_path_sanitizes_session_id() {
        // A stale session_id with a forward slash would otherwise be
        // interpreted as a path separator and the resulting filename
        // would be syntactically invalid on Windows -> os error 123.
        let p = predict_jsonl_path(std::path::Path::new("/x"), "bad/id?with*chars");
        let name = p.file_name().unwrap().to_string_lossy();
        assert_eq!(name, "bad-id-with-chars.jsonl");
    }
}
