use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage;

/// One persisted claude session for a given project. The pty itself does not
/// outlive the app — on next boot we re-spawn `claude --session-id <id>`,
/// which resumes from the existing JSONL transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    pub session_id: String,
    pub label: String,
    pub cwd: PathBuf,
    pub skip_permissions: bool,
    pub created_at_ms: u64,
}

#[tauri::command]
pub fn save_sessions(project_id: String, sessions: Vec<PersistedSession>) -> Result<(), String> {
    tracing::debug!(target: "deepthix::commands", %project_id, count = sessions.len(), "save_sessions");
    let dir = storage::project_dir(&project_id).map_err(|e| e.to_string())?;
    let path = dir.join("sessions.json");
    storage::write_json(&path, &sessions).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_sessions(project_id: String) -> Result<Vec<PersistedSession>, String> {
    tracing::debug!(target: "deepthix::commands", %project_id, "load_sessions");
    let dir = storage::project_dir(&project_id).map_err(|e| e.to_string())?;
    let path = dir.join("sessions.json");
    let value = storage::read_json::<Vec<PersistedSession>>(&path).map_err(|e| e.to_string())?;
    Ok(value.unwrap_or_default())
}
