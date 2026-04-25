// Per-project persistence of the open-files list for the Files mode pane.
// Stored at `~/.deepthix/projects/<id>/open_files.json`. On project switch
// (or reboot) the Files pane reloads this list and reopens each tab.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenFile {
    pub path: PathBuf,
}

/// Persist the user's currently-open files for `project_id`. Overwrites the
/// previous list — caller passes the full set every save.
#[tauri::command]
pub fn save_open_files(project_id: String, files: Vec<OpenFile>) -> Result<(), String> {
    tracing::debug!(target: "deepthix::commands", %project_id, count = files.len(), "save_open_files");
    let dir = storage::project_dir(&project_id).map_err(|e| e.to_string())?;
    let path = dir.join("open_files.json");
    storage::write_json(&path, &files).map_err(|e| e.to_string())
}

/// Load the persisted open-files list for `project_id`. Returns an empty list
/// when no file exists yet (first time the user opens the Files pane).
#[tauri::command]
pub fn load_open_files(project_id: String) -> Result<Vec<OpenFile>, String> {
    tracing::debug!(target: "deepthix::commands", %project_id, "load_open_files");
    let dir = storage::project_dir(&project_id).map_err(|e| e.to_string())?;
    let path = dir.join("open_files.json");
    let value = storage::read_json::<Vec<OpenFile>>(&path).map_err(|e| e.to_string())?;
    Ok(value.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_then_load_roundtrips() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let files = vec![
            OpenFile { path: PathBuf::from("/tmp/a.txt") },
            OpenFile { path: PathBuf::from("/tmp/b.rs") },
        ];
        save_open_files(id.clone(), files.clone()).unwrap();
        let loaded = load_open_files(id.clone()).unwrap();
        assert_eq!(loaded, files);
        // Cleanup
        let _ = std::fs::remove_dir_all(
            storage::deepthix_dir().unwrap().join("projects").join(&id),
        );
    }

    #[test]
    fn load_returns_empty_when_no_file() {
        let id = format!("nofile-{}", uuid::Uuid::new_v4());
        let loaded = load_open_files(id.clone()).unwrap();
        assert!(loaded.is_empty());
        let _ = std::fs::remove_dir_all(
            storage::deepthix_dir().unwrap().join("projects").join(&id),
        );
    }
}
