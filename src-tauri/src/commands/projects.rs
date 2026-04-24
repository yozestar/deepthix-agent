use std::path::PathBuf;

use serde::Serialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::state::{AppState, Project, ProjectsFile};

#[tauri::command]
pub async fn open_folder(app: tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    tracing::debug!(target: "deepthix::commands", "open_folder invoked");
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .pick_folder(move |path| {
            let _ = tx.send(path.map(|p| p.into_path().ok()).flatten());
        });
    let picked = rx.recv().map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| std::fs::canonicalize(&p).ok()))
}

#[tauri::command]
pub fn add_project(state: State<'_, AppState>, path: PathBuf) -> Result<Project, String> {
    tracing::info!(target: "deepthix::commands", ?path, "add_project");
    let canonical = std::fs::canonicalize(&path).map_err(|e| {
        format!("cannot canonicalize {}: {}", path.display(), e)
    })?;
    tracing::debug!(target: "deepthix::commands", ?path, ?canonical, "canonicalized");
    state.add(canonical).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> ProjectsFile {
    let snap = state.snapshot();
    tracing::debug!(target: "deepthix::commands", count = snap.projects.len(), "list_projects");
    snap
}

#[derive(Serialize)]
pub struct SwitchResult { pub ok: bool }

#[tauri::command]
pub fn switch_project(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<SwitchResult, String> {
    tracing::info!(target: "deepthix::commands", %id, "switch_project");
    let ok = state.switch(&id).map_err(|e| e.to_string())?;
    if ok {
        let _ = tauri::Emitter::emit(&app, "project_switched", &id);
    }
    Ok(SwitchResult { ok })
}

#[tauri::command]
pub fn remove_project(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    tracing::info!(target: "deepthix::commands", %id, "remove_project");
    state.remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<bool, String> {
    tracing::info!(target: "deepthix::commands", %id, %name, "rename_project");
    state.rename(&id, name).map_err(|e| e.to_string())
}
