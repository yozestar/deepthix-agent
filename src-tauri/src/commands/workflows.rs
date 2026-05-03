// Workflows — named claude prompt recipes the user (or claude itself,
// via Read/Write on the JSON file) can save, edit, and re-fire on
// demand. Stored as a single catalog at ~/.deepthix/workflows.json so
// every claude session can discover them without per-project plumbing.
//
// Run history lives in append-only JSONL at
// ~/.deepthix/workflows/<workflow_id>/runs.jsonl — one record per
// invocation: { run_id, started_ms, ended_ms?, target_session_id,
// target_project_id, prompt, status }. The run_workflow command only
// writes the "started" record; the FE appends a follow-up "ended"
// record once the user closes the run or claude reports completion.
//
// Schema is intentionally simple JSON — claude can `Edit`/`Write` the
// catalog directly to add or modify entries without needing a custom
// tool. The user can also do all of that from the WORKFLOW tab.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub prompt: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub updated_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRun {
    pub run_id: String,
    pub workflow_id: String,
    pub started_ms: u64,
    #[serde(default)]
    pub ended_ms: Option<u64>,
    #[serde(default)]
    pub target_session_id: Option<String>,
    #[serde(default)]
    pub target_project_id: Option<String>,
    #[serde(default)]
    pub prompt: String,
    /// "running" | "ok" | "error" | "interrupted"
    pub status: String,
}

fn workflows_catalog_path() -> std::io::Result<PathBuf> {
    Ok(storage::deepthix_dir()?.join("workflows.json"))
}

fn workflow_runs_path(workflow_id: &str) -> std::io::Result<PathBuf> {
    let dir = storage::deepthix_dir()?
        .join("workflows")
        .join(workflow_id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("runs.jsonl"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_catalog() -> Result<Vec<Workflow>, String> {
    let path = workflows_catalog_path().map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(s) if s.trim().is_empty() => Ok(Vec::new()),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("parse workflows.json: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read workflows.json: {e}")),
    }
}

fn save_catalog(workflows: &[Workflow]) -> Result<(), String> {
    let path = workflows_catalog_path().map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(workflows).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn workflows_path() -> Result<String, String> {
    let path = workflows_catalog_path().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_workflows() -> Result<Vec<Workflow>, String> {
    load_catalog()
}

#[tauri::command]
pub fn create_workflow(name: String, description: String, prompt: String, tags: Vec<String>) -> Result<Workflow, String> {
    let mut catalog = load_catalog()?;
    let now = now_ms();
    let id = format!("wf-{}-{}", now, uuid::Uuid::new_v4().simple());
    let wf = Workflow {
        id: id.clone(),
        name,
        description,
        prompt,
        tags,
        created_ms: now,
        updated_ms: now,
    };
    catalog.push(wf.clone());
    save_catalog(&catalog)?;
    tracing::info!(target: "deepthix::workflows", %id, "create_workflow");
    Ok(wf)
}

#[tauri::command]
pub fn update_workflow(
    id: String,
    name: Option<String>,
    description: Option<String>,
    prompt: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Workflow, String> {
    let mut catalog = load_catalog()?;
    let wf = catalog
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("no workflow {id}"))?;
    if let Some(n) = name {
        wf.name = n;
    }
    if let Some(d) = description {
        wf.description = d;
    }
    if let Some(p) = prompt {
        wf.prompt = p;
    }
    if let Some(t) = tags {
        wf.tags = t;
    }
    wf.updated_ms = now_ms();
    let updated = wf.clone();
    save_catalog(&catalog)?;
    tracing::info!(target: "deepthix::workflows", %id, "update_workflow");
    Ok(updated)
}

#[tauri::command]
pub fn delete_workflow(id: String) -> Result<(), String> {
    let mut catalog = load_catalog()?;
    let before = catalog.len();
    catalog.retain(|w| w.id != id);
    if catalog.len() == before {
        return Err(format!("no workflow {id}"));
    }
    save_catalog(&catalog)?;
    // Also drop the runs directory if it exists. Best-effort — a stuck
    // permission error here shouldn't block the catalog delete.
    let runs_dir = storage::deepthix_dir()
        .map_err(|e| e.to_string())?
        .join("workflows")
        .join(&id);
    let _ = std::fs::remove_dir_all(&runs_dir);
    tracing::info!(target: "deepthix::workflows", %id, "delete_workflow");
    Ok(())
}

#[tauri::command]
pub fn list_workflow_runs(workflow_id: String) -> Result<Vec<WorkflowRun>, String> {
    let path = workflow_runs_path(&workflow_id).map_err(|e| e.to_string())?;
    let body = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read runs.jsonl: {e}")),
    };
    // The JSONL log records both "started" and "ended" entries. Fold
    // them so each run_id appears once with the latest fields.
    use std::collections::BTreeMap;
    let mut by_id: BTreeMap<String, WorkflowRun> = BTreeMap::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let run: WorkflowRun = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // Merge: keep the entry with the latest update — ended_ms set
        // beats the started entry.
        match by_id.get(&run.run_id) {
            Some(existing) if existing.ended_ms.is_some() && run.ended_ms.is_none() => {}
            _ => {
                by_id.insert(run.run_id.clone(), run);
            }
        }
    }
    // Newest first — easier to scan.
    let mut runs: Vec<WorkflowRun> = by_id.into_values().collect();
    runs.sort_by(|a, b| b.started_ms.cmp(&a.started_ms));
    Ok(runs)
}

#[tauri::command]
pub fn append_workflow_run(run: WorkflowRun) -> Result<(), String> {
    let path = workflow_runs_path(&run.workflow_id).map_err(|e| e.to_string())?;
    let line = serde_json::to_string(&run).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open runs.jsonl: {e}"))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("write runs.jsonl: {e}"))?;
    f.write_all(b"\n").map_err(|e| e.to_string())?;
    Ok(())
}
