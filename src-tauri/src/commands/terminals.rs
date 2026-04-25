use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::jsonl_watcher::{predict_jsonl_path, JsonlWatcher};
use crate::pty::TerminalManager;

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum TerminalKind {
    #[default]
    Shell,
    Claude,
}

#[derive(Serialize, Clone)]
pub struct SpawnResult {
    pub id: String,
    pub session_id: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PtyDataPayload {
    pub id: String,
    pub data: String,
}

#[derive(Serialize, Clone)]
pub struct AgentJsonlPayload {
    pub id: String,
    pub session_id: String,
    pub line: String,
}

/// Holds JsonlWatchers keyed by terminal id so they live as long as the agent.
/// Dropping the watcher (via `remove`) stops the polling thread.
#[derive(Default)]
pub struct WatcherRegistry {
    inner: Mutex<std::collections::HashMap<String, Arc<JsonlWatcher>>>,
}

impl WatcherRegistry {
    pub fn insert(&self, id: String, watcher: JsonlWatcher) {
        tracing::debug!(target: "deepthix::commands", %id, "watcher registered");
        self.inner.lock().unwrap().insert(id, Arc::new(watcher));
    }
    pub fn remove(&self, id: &str) {
        if self.inner.lock().unwrap().remove(id).is_some() {
            tracing::debug!(target: "deepthix::commands", %id, "watcher removed");
        }
    }
}

#[tauri::command]
pub fn spawn_terminal(
    app: AppHandle,
    pty: State<'_, TerminalManager>,
    watchers: State<'_, WatcherRegistry>,
    cwd: PathBuf,
    cols: Option<u16>,
    rows: Option<u16>,
    kind: Option<TerminalKind>,
    skip_permissions: Option<bool>,
    resume_session_id: Option<String>,
) -> Result<SpawnResult, String> {
    let kind = kind.unwrap_or_default();
    let skip_permissions = skip_permissions.unwrap_or(false);
    let id = format!("term-{}", Uuid::new_v4().simple());
    tracing::info!(target: "deepthix::commands", %id, ?cwd, kind = serialize_kind(&kind), ?cols, ?rows, skip_permissions, ?resume_session_id, "spawn_terminal");

    let app_data = app.clone();
    pty.spawn_with_kind(
        id.clone(),
        cwd.clone(),
        cols.unwrap_or(80),
        rows.unwrap_or(24),
        &kind,
        skip_permissions,
        resume_session_id,
        move |term_id, data| {
            let payload = PtyDataPayload {
                id: term_id.to_string(),
                data: String::from_utf8_lossy(data).to_string(),
            };
            if let Err(e) = app_data.emit("pty_data", payload) {
                tracing::warn!(target: "deepthix::commands", id = %term_id, error = %e, "emit pty_data failed");
            }
        },
    )
    .map_err(|e| {
        tracing::error!(target: "deepthix::commands", %id, error = %e, "spawn_terminal failed");
        e.to_string()
    })?;

    let session_id = match kind {
        TerminalKind::Claude => {
            let session_id = pty.get_session_id(&id).unwrap_or_default();
            let jsonl = predict_jsonl_path(&cwd, &session_id);
            tracing::info!(target: "deepthix::commands", %id, %session_id, ?jsonl, "watching jsonl");

            let app_for_watcher = app.clone();
            let id_for_watcher = id.clone();
            let session_for_watcher = session_id.clone();
            let watcher = JsonlWatcher::start(jsonl, move |line| {
                let payload = AgentJsonlPayload {
                    id: id_for_watcher.clone(),
                    session_id: session_for_watcher.clone(),
                    line: line.to_string(),
                };
                if let Err(e) = app_for_watcher.emit("agent_jsonl_line", payload) {
                    tracing::warn!(target: "deepthix::commands", id = %id_for_watcher, error = %e, "emit agent_jsonl_line failed");
                }
            });
            watchers.insert(id.clone(), watcher);
            Some(session_id)
        }
        TerminalKind::Shell => None,
    };

    tracing::info!(target: "deepthix::commands", %id, ?session_id, "spawn_terminal ok");
    Ok(SpawnResult { id, session_id })
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, TerminalManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    tracing::trace!(target: "deepthix::commands", %id, bytes = data.len(), "pty_write");
    state.write(&id, data.as_bytes()).map_err(|e| {
        tracing::warn!(target: "deepthix::commands", %id, error = %e, "pty_write failed");
        e.to_string()
    })
}

#[tauri::command]
pub fn pty_resize(state: State<'_, TerminalManager>, id: String, cols: u16, rows: u16) {
    tracing::debug!(target: "deepthix::commands", %id, cols, rows, "pty_resize");
    state.resize(&id, cols, rows);
}

#[tauri::command]
pub fn kill_terminal(
    pty: State<'_, TerminalManager>,
    watchers: State<'_, WatcherRegistry>,
    id: String,
) {
    tracing::info!(target: "deepthix::commands", %id, "kill_terminal");
    pty.kill(&id);
    watchers.remove(&id);
}

fn serialize_kind(k: &TerminalKind) -> &'static str {
    match k {
        TerminalKind::Shell => "shell",
        TerminalKind::Claude => "claude",
    }
}
