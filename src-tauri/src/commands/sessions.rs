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

/// Dedup by session_id, keeping the LAST occurrence (newer label, etc.).
/// Defensive cleanup: a previous double-spawn bug wrote the same session
/// id multiple times into sessions.json, causing N parallel claude
/// processes to spawn on next boot for a single conversation.
fn dedup_sessions(sessions: Vec<PersistedSession>) -> Vec<PersistedSession> {
    let mut seen: std::collections::HashMap<String, PersistedSession> =
        std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for s in sessions {
        if !seen.contains_key(&s.session_id) {
            order.push(s.session_id.clone());
        }
        seen.insert(s.session_id.clone(), s);
    }
    order.into_iter().filter_map(|id| seen.remove(&id)).collect()
}

#[tauri::command]
pub fn save_sessions(project_id: String, sessions: Vec<PersistedSession>) -> Result<(), String> {
    let cleaned = dedup_sessions(sessions);
    tracing::debug!(target: "deepthix::commands", %project_id, count = cleaned.len(), "save_sessions");
    let dir = storage::project_dir(&project_id).map_err(|e| e.to_string())?;
    let path = dir.join("sessions.json");
    storage::write_json(&path, &cleaned).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_sessions(project_id: String) -> Result<Vec<PersistedSession>, String> {
    tracing::debug!(target: "deepthix::commands", %project_id, "load_sessions");
    let dir = storage::project_dir(&project_id).map_err(|e| e.to_string())?;
    let path = dir.join("sessions.json");
    let value = storage::read_json::<Vec<PersistedSession>>(&path).map_err(|e| e.to_string())?;
    Ok(dedup_sessions(value.unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: &str, label: &str) -> PersistedSession {
        PersistedSession {
            session_id: id.into(),
            label: label.into(),
            cwd: PathBuf::from("/tmp"),
            skip_permissions: false,
            created_at_ms: 0,
            font_size: None,
            font_family: None,
            line_height: None,
            notes: None,
        }
    }

    #[test]
    fn dedup_keeps_last_occurrence() {
        let input = vec![
            mk("a", "first-a"),
            mk("b", "only-b"),
            mk("a", "second-a"),
            mk("a", "third-a"),
        ];
        let out = dedup_sessions(input);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].session_id, "a");
        assert_eq!(out[0].label, "third-a"); // last wins
        assert_eq!(out[1].session_id, "b");
    }

    #[test]
    fn dedup_preserves_first_seen_order() {
        let input = vec![mk("z", "z"), mk("a", "a"), mk("z", "z2"), mk("m", "m")];
        let out = dedup_sessions(input);
        let ids: Vec<&str> = out.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, vec!["z", "a", "m"]);
    }
}
