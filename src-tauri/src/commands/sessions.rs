use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage;

/// One persisted claude session for a given project. The pty itself does not
/// outlive the app — on next boot we re-spawn `claude --session-id <id>`,
/// which resumes from the existing JSONL transcript.
///
/// `font_size`, `font_family`, and `line_height` are per-session terminal
/// customization fields (Phase 10). They are optional + `#[serde(default)]`
/// so older `sessions.json` files (written before this field set existed)
/// still deserialize cleanly — the frontend supplies sensible defaults
/// when the value is `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    pub session_id: String,
    pub label: String,
    pub cwd: PathBuf,
    pub skip_permissions: bool,
    pub created_at_ms: u64,
    #[serde(default)]
    pub font_size: Option<i32>,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub line_height: Option<f32>,
    /// Free-form per-session notes shown in the OVERVIEW tab. Lets the user
    /// pin important context (campaign id, blockers, env vars, etc.) next
    /// to the brain so they don't have to dig through scrollback to find
    /// it. `#[serde(default)]` so older `sessions.json` still deserializes.
    #[serde(default)]
    pub notes: Option<String>,
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
