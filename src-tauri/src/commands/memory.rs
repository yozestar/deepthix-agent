use std::path::PathBuf;

/// Read the project-level CLAUDE.md (project_path/CLAUDE.md). Returns "" if absent.
#[tauri::command]
pub fn read_project_memory(project_path: PathBuf) -> Result<String, String> {
    let path = project_path.join("CLAUDE.md");
    tracing::debug!(target: "deepthix::commands", ?path, "read_project_memory");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(target: "deepthix::commands", ?path, "read_project_memory: absent");
            Ok(String::new())
        }
        Err(e) => {
            tracing::warn!(target: "deepthix::commands", ?path, error = %e, "read_project_memory failed");
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn write_project_memory(project_path: PathBuf, content: String) -> Result<(), String> {
    let path = project_path.join("CLAUDE.md");
    tracing::info!(target: "deepthix::commands", ?path, bytes = content.len(), "write_project_memory");
    std::fs::write(&path, content).map_err(|e| {
        tracing::warn!(target: "deepthix::commands", ?path, error = %e, "write_project_memory failed");
        e.to_string()
    })
}

/// Read the global ~/.claude/CLAUDE.md. Returns "" if absent.
#[tauri::command]
pub fn read_global_memory() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let path = home.join(".claude").join("CLAUDE.md");
    tracing::debug!(target: "deepthix::commands", ?path, "read_global_memory");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(target: "deepthix::commands", ?path, "read_global_memory: absent");
            Ok(String::new())
        }
        Err(e) => {
            tracing::warn!(target: "deepthix::commands", ?path, error = %e, "read_global_memory failed");
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn write_global_memory(content: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dir = home.join(".claude");
    tracing::info!(target: "deepthix::commands", ?dir, bytes = content.len(), "write_global_memory");
    std::fs::create_dir_all(&dir).map_err(|e| {
        tracing::warn!(target: "deepthix::commands", ?dir, error = %e, "write_global_memory: mkdir failed");
        e.to_string()
    })?;
    std::fs::write(dir.join("CLAUDE.md"), content).map_err(|e| {
        tracing::warn!(target: "deepthix::commands", ?dir, error = %e, "write_global_memory: write failed");
        e.to_string()
    })
}
