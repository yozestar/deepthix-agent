use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::pty::TerminalManager;

#[derive(Serialize, Clone)]
pub struct SpawnResult {
    pub id: String,
}

#[derive(Serialize, Clone)]
pub struct PtyDataPayload {
    pub id: String,
    pub data: String,
}

#[tauri::command]
pub fn spawn_terminal(
    app: AppHandle,
    state: State<'_, TerminalManager>,
    cwd: PathBuf,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SpawnResult, String> {
    let id = format!("term-{}", uuid_short());
    tracing::info!(target: "deepthix::commands", %id, ?cwd, ?cols, ?rows, "spawn_terminal");
    let app_clone = app.clone();
    state
        .spawn_shell(
            id.clone(),
            cwd,
            cols.unwrap_or(80),
            rows.unwrap_or(24),
            move |term_id, data| {
                let payload = PtyDataPayload {
                    id: term_id.to_string(),
                    data: String::from_utf8_lossy(data).to_string(),
                };
                if let Err(e) = app_clone.emit("pty_data", payload) {
                    tracing::warn!(target: "deepthix::commands", id = %term_id, error = %e, "emit pty_data failed");
                }
            },
        )
        .map_err(|e| {
            tracing::error!(target: "deepthix::commands", %id, error = %e, "spawn_terminal failed");
            e.to_string()
        })?;
    tracing::info!(target: "deepthix::commands", %id, "spawn_terminal ok");
    Ok(SpawnResult { id })
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
pub fn kill_terminal(state: State<'_, TerminalManager>, id: String) {
    tracing::info!(target: "deepthix::commands", %id, "kill_terminal");
    state.kill(&id);
}

fn uuid_short() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos as u64)
}
