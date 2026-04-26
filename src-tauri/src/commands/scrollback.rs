// Per-session terminal scrollback persistence. Stored at
// `~/.deepthix/projects/<project_id>/scrollback/<session_id>.ansi`. The
// frontend serializes its xterm buffer (via `@xterm/addon-serialize` —
// pure ANSI escape sequences) on unmount + every 30s, and replays it on
// the next mount so users see their conversation history when they reopen
// the app.
//
// We key by `session_id` (claude's `--resume` UUID) NOT by terminal id
// because terminal ids are regenerated each launch, while the session id
// is the stable handle to the same claude conversation.
//
// Files are plain text (UTF-8). Atomic write via `<file>.tmp` + rename so
// a crash mid-write doesn't truncate the previous good copy. Best-effort
// cleanup on session close (`clear_terminal_scrollback`) so a removed
// project doesn't leak megabytes of dead conversation buffers.

use std::path::PathBuf;

use crate::storage;

fn scrollback_path(project_id: &str, session_id: &str) -> std::io::Result<PathBuf> {
    let dir = storage::project_dir(project_id)?.join("scrollback");
    std::fs::create_dir_all(&dir)?;
    // Defensive: refuse path-traversal-ish session ids. claude UUIDs are
    // hex+dashes only, so anything with `/` or `..` is malformed.
    if session_id.contains('/') || session_id.contains("..") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid session_id for scrollback: {session_id}"),
        ));
    }
    Ok(dir.join(format!("{session_id}.ansi")))
}

#[tauri::command]
pub fn save_terminal_scrollback(
    project_id: String,
    session_id: String,
    content: String,
) -> Result<(), String> {
    let path = scrollback_path(&project_id, &session_id).map_err(|e| e.to_string())?;
    tracing::debug!(
        target: "deepthix::commands",
        %project_id, %session_id, bytes = content.len(),
        "save_terminal_scrollback",
    );
    let tmp = path.with_extension("ansi.tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_terminal_scrollback(
    project_id: String,
    session_id: String,
) -> Result<Option<String>, String> {
    let path = scrollback_path(&project_id, &session_id).map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            tracing::debug!(
                target: "deepthix::commands",
                %project_id, %session_id, bytes = s.len(),
                "load_terminal_scrollback hit",
            );
            Ok(Some(s))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(
                target: "deepthix::commands",
                %project_id, %session_id,
                "load_terminal_scrollback miss",
            );
            Ok(None)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[derive(serde::Serialize)]
pub struct JsonlStat {
    /// File size in bytes. 0 if missing.
    pub size_bytes: u64,
    /// Last-modified epoch ms. 0 if missing.
    pub mtime_ms: u64,
}

/// Stat (size + mtime) of the JSONL transcript file for a claude session.
/// Frontend's "is this session working?" heuristic uses SIZE growth, not
/// mtime — claude touches its JSONL on resume / heartbeat / metadata
/// updates without writing new content, and a pure mtime check produced
/// false-positive working flashes when the user wasn't doing anything.
/// New bytes = real activity.
#[tauri::command]
pub fn jsonl_mtime_ms(project_cwd: String, session_id: String) -> Result<JsonlStat, String> {
    let path =
        crate::jsonl_watcher::predict_jsonl_path(std::path::Path::new(&project_cwd), &session_id);
    match std::fs::metadata(&path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .map_err(|e| e.to_string())?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis() as u64;
            Ok(JsonlStat {
                size_bytes: meta.len(),
                mtime_ms: mtime,
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(JsonlStat {
            size_bytes: 0,
            mtime_ms: 0,
        }),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn clear_terminal_scrollback(
    project_id: String,
    session_id: String,
) -> Result<(), String> {
    let path = scrollback_path(&project_id, &session_id).map_err(|e| e.to_string())?;
    tracing::debug!(
        target: "deepthix::commands",
        %project_id, %session_id,
        "clear_terminal_scrollback",
    );
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_load_roundtrip() {
        let pid = format!("test-scroll-{}", uuid::Uuid::new_v4());
        let sid = "abc-123-def-456".to_string();
        let content = "\u{1b}[31mhello\u{1b}[0m world\r\n".to_string();
        save_terminal_scrollback(pid.clone(), sid.clone(), content.clone()).unwrap();
        let loaded = load_terminal_scrollback(pid.clone(), sid.clone()).unwrap();
        assert_eq!(loaded, Some(content));
        let _ = std::fs::remove_dir_all(
            storage::deepthix_dir().unwrap().join("projects").join(&pid),
        );
    }

    #[test]
    fn load_returns_none_when_missing() {
        let pid = format!("nofile-scroll-{}", uuid::Uuid::new_v4());
        let loaded = load_terminal_scrollback(pid.clone(), "x".into()).unwrap();
        assert!(loaded.is_none());
        let _ = std::fs::remove_dir_all(
            storage::deepthix_dir().unwrap().join("projects").join(&pid),
        );
    }

    #[test]
    fn rejects_path_traversal_session_ids() {
        let result = scrollback_path("p", "../etc/passwd");
        assert!(result.is_err());
        let result2 = scrollback_path("p", "a/b");
        assert!(result2.is_err());
    }

    #[test]
    fn clear_is_idempotent() {
        let pid = format!("clear-scroll-{}", uuid::Uuid::new_v4());
        // Clearing a non-existent file is fine.
        clear_terminal_scrollback(pid.clone(), "missing".into()).unwrap();
        // After save + clear, file is gone.
        save_terminal_scrollback(pid.clone(), "s".into(), "x".into()).unwrap();
        clear_terminal_scrollback(pid.clone(), "s".into()).unwrap();
        let loaded = load_terminal_scrollback(pid.clone(), "s".into()).unwrap();
        assert!(loaded.is_none());
        let _ = std::fs::remove_dir_all(
            storage::deepthix_dir().unwrap().join("projects").join(&pid),
        );
    }
}
