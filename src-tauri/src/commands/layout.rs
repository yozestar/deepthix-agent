use serde_json::Value;

use crate::storage;

#[tauri::command]
pub fn save_layout(project_id: String, layout: Value) -> Result<(), String> {
    tracing::info!(target: "deepthix::commands", %project_id, "save_layout");
    let dir = storage::project_dir(&project_id).map_err(|e| e.to_string())?;
    let path = dir.join("layout.json");
    storage::write_json(&path, &layout).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_layout(project_id: String) -> Result<Option<Value>, String> {
    tracing::debug!(target: "deepthix::commands", %project_id, "load_layout");
    let dir = storage::project_dir(&project_id).map_err(|e| e.to_string())?;
    let path = dir.join("layout.json");
    storage::read_json::<Value>(&path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn save_then_load_roundtrips() {
        let id = format!("test-{}", std::process::id());
        let layout = json!({"version": 1, "tiles": [1, 2, 3]});
        save_layout(id.clone(), layout.clone()).unwrap();
        let loaded = load_layout(id.clone()).unwrap();
        assert_eq!(loaded, Some(layout));
        // Cleanup
        let _ = std::fs::remove_dir_all(storage::project_dir(&id).unwrap());
    }

    #[test]
    fn load_missing_returns_none() {
        let id = format!("test-missing-{}", std::process::id());
        let loaded = load_layout(id.clone()).unwrap();
        assert_eq!(loaded, None);
        let _ = std::fs::remove_dir_all(storage::project_dir(&id).unwrap());
    }
}
