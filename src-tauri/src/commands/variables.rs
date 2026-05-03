// Shared key/value variables — a cross-session scratchpad both the
// user (via the VARIABLES tab) and claude (via Read/Write on the JSON
// catalog) can read/write. Use cases: store an API token name,
// pin a current sprint id, share a deploy target between sessions, etc.
//
// Storage: ~/.deepthix/variables.json — array of { key, value,
// description, created_ms, updated_ms }. Atomic writes via .tmp +
// rename. Keys are unique; set_variable upserts.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variable {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub updated_ms: u64,
}

fn variables_catalog_path() -> std::io::Result<PathBuf> {
    Ok(storage::deepthix_dir()?.join("variables.json"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_catalog() -> Result<Vec<Variable>, String> {
    let path = variables_catalog_path().map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(s) if s.trim().is_empty() => Ok(Vec::new()),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("parse variables.json: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read variables.json: {e}")),
    }
}

fn save_catalog(vars: &[Variable]) -> Result<(), String> {
    let path = variables_catalog_path().map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(vars).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn variables_path() -> Result<String, String> {
    let path = variables_catalog_path().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_variables() -> Result<Vec<Variable>, String> {
    let mut catalog = load_catalog()?;
    catalog.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(catalog)
}

/// Upsert: replaces the existing entry with the same key, or appends
/// a new one. Returns the saved Variable.
#[tauri::command]
pub fn set_variable(
    key: String,
    value: String,
    description: Option<String>,
) -> Result<Variable, String> {
    if key.trim().is_empty() {
        return Err("key cannot be empty".to_string());
    }
    let mut catalog = load_catalog()?;
    let now = now_ms();
    let saved = if let Some(existing) = catalog.iter_mut().find(|v| v.key == key) {
        existing.value = value;
        if let Some(d) = description {
            existing.description = d;
        }
        existing.updated_ms = now;
        existing.clone()
    } else {
        let v = Variable {
            key: key.clone(),
            value,
            description: description.unwrap_or_default(),
            created_ms: now,
            updated_ms: now,
        };
        catalog.push(v.clone());
        v
    };
    save_catalog(&catalog)?;
    tracing::info!(target: "deepthix::variables", %key, "set_variable");
    Ok(saved)
}

#[tauri::command]
pub fn delete_variable(key: String) -> Result<(), String> {
    let mut catalog = load_catalog()?;
    let before = catalog.len();
    catalog.retain(|v| v.key != key);
    if catalog.len() == before {
        return Err(format!("no variable {key}"));
    }
    save_catalog(&catalog)?;
    tracing::info!(target: "deepthix::variables", %key, "delete_variable");
    Ok(())
}
