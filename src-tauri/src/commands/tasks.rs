//! Tasks ("reste à faire"): Tauri commands over `crate::tasks_store`
//! (`~/.elyone/tasks.json`, shared with the deepthix-mcp sidecar).

use std::path::PathBuf;

use crate::tasks_store::{self, Task, TaskInput};

fn tasks_path() -> Result<PathBuf, String> {
    Ok(crate::storage::deepthix_dir().map_err(|e| e.to_string())?.join(tasks_store::TASKS_FILE))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Every task, or only one project's.
#[tauri::command]
pub async fn tasks_list(project_id: Option<String>) -> Result<Vec<Task>, String> {
    let all = tasks_store::load(&tasks_path()?)?;
    Ok(match project_id {
        Some(pid) => all.into_iter().filter(|t| t.project_id == pid).collect(),
        None => all,
    })
}

#[tauri::command]
pub async fn task_save(task: TaskInput) -> Result<Task, String> {
    tasks_store::upsert(&tasks_path()?, task, now_ms())
}

#[tauri::command]
pub async fn task_set_done(id: String, done: bool) -> Result<Task, String> {
    tasks_store::set_done(&tasks_path()?, &id, done, now_ms())
}

#[tauri::command]
pub async fn task_delete(id: String) -> Result<(), String> {
    tasks_store::delete(&tasks_path()?, &id)
}
