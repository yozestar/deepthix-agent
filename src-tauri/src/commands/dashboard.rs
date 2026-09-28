// Project-level HTML dashboard. ONE file per project at
// `~/.deepthix/projects/<project_id>/dashboard.html`. Any claude session
// in the project can write into that file (via the Write tool) to surface
// the project's current state — the OVERVIEW pane renders the contents
// inside a sandboxed iframe and auto-refreshes when it changes.
//
// Was per-session before (one html per session_id under dashboards/).
// User feedback: "l'overview ne doit plus être par session mais general
// au projet". Per-session was confusing — multiple sessions in the same
// project meant multiple dashboards to flip between, none of which
// gave a project-wide picture. The single project file lets sessions
// COLLABORATE on one shared status board (last writer wins).
//
// The session_id parameter is kept on `read_session_dashboard` /
// `dashboard_mtime_ms` for frontend compat (callers were structured
// around per-session paths) but it's IGNORED — every call returns
// the same project-level file.

use std::path::PathBuf;

use crate::storage;

pub fn project_dashboard_file(project_id: &str) -> std::io::Result<PathBuf> {
    let dir = storage::project_dir(project_id)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("dashboard.html"))
}

#[tauri::command]
pub fn dashboard_path(project_id: String, session_id: String) -> Result<String, String> {
    let _ = session_id; // see module doc — ignored for project-level dashboards
    let path = project_dashboard_file(&project_id).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn read_session_dashboard(
    project_id: String,
    session_id: String,
) -> Result<Option<String>, String> {
    let _ = session_id;
    let path = project_dashboard_file(&project_id).map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            tracing::debug!(
                target: "deepthix::commands",
                %project_id, bytes = s.len(),
                "read_session_dashboard hit (project-level)",
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
    let _ = session_id;
    let path = project_dashboard_file(&project_id).map_err(|e| e.to_string())?;
    tracing::debug!(
        target: "deepthix::commands",
        %project_id, bytes = html.len(),
        "write_session_dashboard (project-level)",
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
    let _ = session_id;
    let path = project_dashboard_file(&project_id).map_err(|e| e.to_string())?;
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
    fn write_then_read_roundtrip_ignores_session_id() {
        let pid = format!("test-dash-{}", uuid::Uuid::new_v4());
        let html = "<h1>Hello</h1>".to_string();
        write_session_dashboard(pid.clone(), "abc".into(), html.clone()).unwrap();
        // Different session_id, same project — should hit the same file.
        let loaded = read_session_dashboard(pid.clone(), "different".into()).unwrap();
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
    fn dashboard_path_is_at_project_root() {
        let pid = "abc123".to_string();
        let path = dashboard_path(pid.clone(), "ignored".into()).unwrap();
        let normalized = path.replace('\\', "/");
        assert!(normalized.ends_with("/.elyone/projects/abc123/dashboard.html"), "got {path}");
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
