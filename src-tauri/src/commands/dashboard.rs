// Per-session HTML dashboard. Each claude session gets a stable file path
// at `~/.deepthix/projects/<project_id>/dashboards/<session_id>.html`. The
// session is meant to write into that file via its normal Write tool to
// surface important context (campaign id, KPIs, blockers, links) — the
// OVERVIEW pane renders the file's contents inside a sandboxed iframe and
// auto-refreshes when it changes.
//
// `dashboard_path` returns the absolute path so the UI can display it
// (and the user can copy/paste it into a claude prompt). `read_session_dashboard`
// returns the file contents as a string for the iframe srcdoc; `write_session_dashboard`
// is exposed for completeness but the expected pattern is for claude itself
// to write the file.

use std::path::PathBuf;

use crate::storage;

fn dashboards_dir(project_id: &str) -> std::io::Result<PathBuf> {
    let dir = storage::project_dir(project_id)?.join("dashboards");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn dashboard_file(project_id: &str, session_id: &str) -> std::io::Result<PathBuf> {
    if session_id.contains('/') || session_id.contains("..") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid session_id for dashboard: {session_id}"),
        ));
    }
    Ok(dashboards_dir(project_id)?.join(format!("{session_id}.html")))
}

#[tauri::command]
pub fn dashboard_path(project_id: String, session_id: String) -> Result<String, String> {
    let path = dashboard_file(&project_id, &session_id).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn read_session_dashboard(
    project_id: String,
    session_id: String,
) -> Result<Option<String>, String> {
    let path = dashboard_file(&project_id, &session_id).map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            tracing::debug!(
                target: "deepthix::commands",
                %project_id, %session_id, bytes = s.len(),
                "read_session_dashboard hit",
            );
            Ok(Some(s))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn write_session_dashboard(
    project_id: String,
    session_id: String,
    html: String,
) -> Result<(), String> {
    let path = dashboard_file(&project_id, &session_id).map_err(|e| e.to_string())?;
    tracing::debug!(
        target: "deepthix::commands",
        %project_id, %session_id, bytes = html.len(),
        "write_session_dashboard",
    );
    let tmp = path.with_extension("html.tmp");
    std::fs::write(&tmp, html.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns the file's mtime in milliseconds since epoch (or 0 if missing).
/// Lets the UI cheap-poll for "did anything change?" without re-reading the
/// (potentially large) HTML body.
#[tauri::command]
pub fn dashboard_mtime_ms(project_id: String, session_id: String) -> Result<u64, String> {
    let path = dashboard_file(&project_id, &session_id).map_err(|e| e.to_string())?;
    match std::fs::metadata(&path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .map_err(|e| e.to_string())?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis() as u64;
            Ok(mtime)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_roundtrip() {
        let pid = format!("test-dash-{}", uuid::Uuid::new_v4());
        let sid = "abc-123".to_string();
        let html = "<h1>Hello</h1>".to_string();
        write_session_dashboard(pid.clone(), sid.clone(), html.clone()).unwrap();
        let loaded = read_session_dashboard(pid.clone(), sid.clone()).unwrap();
        assert_eq!(loaded, Some(html));
        let _ = std::fs::remove_dir_all(
            storage::deepthix_dir().unwrap().join("projects").join(&pid),
        );
    }

    #[test]
    fn read_returns_none_when_missing() {
        let pid = format!("nofile-dash-{}", uuid::Uuid::new_v4());
        let loaded = read_session_dashboard(pid.clone(), "x".into()).unwrap();
        assert!(loaded.is_none());
        let _ = std::fs::remove_dir_all(
            storage::deepthix_dir().unwrap().join("projects").join(&pid),
        );
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(dashboard_file("p", "../etc/passwd").is_err());
        assert!(dashboard_file("p", "a/b").is_err());
    }

    #[test]
    fn dashboard_path_is_under_deepthix_projects() {
        let pid = "abc123".to_string();
        let sid = "def456".to_string();
        let path = dashboard_path(pid.clone(), sid.clone()).unwrap();
        assert!(path.contains("/.deepthix/projects/abc123/dashboards/def456.html"), "got {path}");
    }

    #[test]
    fn mtime_zero_when_missing() {
        let pid = format!("nomtime-dash-{}", uuid::Uuid::new_v4());
        assert_eq!(dashboard_mtime_ms(pid.clone(), "x".into()).unwrap(), 0);
        let _ = std::fs::remove_dir_all(
            storage::deepthix_dir().unwrap().join("projects").join(&pid),
        );
    }
}
