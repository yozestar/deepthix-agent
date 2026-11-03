//! Tasks ("reste à faire") shared by the app and the deepthix-mcp sidecar:
//! one JSON array in `~/.elyone/tasks.json`, atomic writes (.tmp + rename).
//! Included by both crates' targets with `#[path]`, so it only depends on
//! serde / serde_json / uuid.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const TASKS_FILE: &str = "tasks.json";
pub const STATUS_TODO: &str = "todo";
pub const STATUS_DONE: &str = "done";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "default_status")]
    pub status: String,
    /// Deadline, `YYYY-MM-DD`.
    #[serde(default)]
    pub due: Option<String>,
    /// Who is waiting on this (a client, a colleague).
    #[serde(default)]
    pub waiting_on: Option<String>,
    /// Conversation it came from, when known (session label).
    #[serde(default)]
    pub session_label: String,
    /// "user" or "agent".
    #[serde(default)]
    pub source: String,
    pub created_ms: u64,
    pub updated_ms: u64,
    #[serde(default)]
    pub done_ms: Option<u64>,
}

fn default_status() -> String {
    STATUS_TODO.to_string()
}

/// Fields a caller may set; `id: None` creates a task.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TaskInput {
    #[serde(default)]
    pub id: Option<String>,
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub waiting_on: Option<String>,
    #[serde(default)]
    pub session_label: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

/// Missing file → empty list. Unreadable file → error (never silently
/// replaced: a later write would otherwise wipe the user's tasks).
pub fn load(path: &Path) -> Result<Vec<Task>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(Vec::new()),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("tasks.json unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("tasks.json: {e}")),
    }
}

fn save(path: &Path, tasks: &[Task]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(tasks).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Creates (`id: None`) or edits a task. Optional fields left out of an
/// edit keep their current value.
pub fn upsert(path: &Path, input: TaskInput, now_ms: u64) -> Result<Task, String> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err("task title cannot be empty".into());
    }
    let mut tasks = load(path)?;
    let saved = match input.id.as_deref().and_then(|id| tasks.iter_mut().find(|t| t.id == id)) {
        Some(t) => {
            t.title = title;
            t.project_id = input.project_id;
            if let Some(n) = input.notes {
                t.notes = n;
            }
            if input.due.is_some() {
                t.due = clean(input.due);
            }
            if input.waiting_on.is_some() {
                t.waiting_on = clean(input.waiting_on);
            }
            if let Some(l) = input.session_label {
                t.session_label = l;
            }
            t.updated_ms = now_ms;
            t.clone()
        }
        None => {
            let t = Task {
                id: uuid::Uuid::new_v4().to_string(),
                project_id: input.project_id,
                title,
                notes: input.notes.unwrap_or_default(),
                status: STATUS_TODO.into(),
                due: clean(input.due),
                waiting_on: clean(input.waiting_on),
                session_label: input.session_label.unwrap_or_default(),
                source: input.source.unwrap_or_else(|| "user".into()),
                created_ms: now_ms,
                updated_ms: now_ms,
                done_ms: None,
            };
            tasks.push(t.clone());
            t
        }
    };
    save(path, &tasks)?;
    Ok(saved)
}

pub fn set_done(path: &Path, id: &str, done: bool, now_ms: u64) -> Result<Task, String> {
    let mut tasks = load(path)?;
    let t = tasks.iter_mut().find(|t| t.id == id).ok_or_else(|| format!("no task {id}"))?;
    t.status = if done { STATUS_DONE } else { STATUS_TODO }.into();
    t.done_ms = done.then_some(now_ms);
    t.updated_ms = now_ms;
    let saved = t.clone();
    save(path, &tasks)?;
    Ok(saved)
}

pub fn delete(path: &Path, id: &str) -> Result<(), String> {
    let mut tasks = load(path)?;
    tasks.retain(|t| t.id != id);
    save(path, &tasks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(project: &str, title: &str) -> TaskInput {
        TaskInput { project_id: project.into(), title: title.into(), ..Default::default() }
    }

    #[test]
    fn missing_file_is_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&dir.path().join(TASKS_FILE)).unwrap(), vec![]);
    }

    #[test]
    fn create_then_reload() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(TASKS_FILE);
        let mut i = input("bee2link", "Relancer EY");
        i.due = Some("2026-11-07".into());
        i.waiting_on = Some("EY".into());
        let t = upsert(&p, i, 100).unwrap();
        assert!(!t.id.is_empty());
        assert_eq!(t.status, STATUS_TODO);
        assert_eq!((t.created_ms, t.updated_ms), (100, 100));
        assert_eq!(load(&p).unwrap(), vec![t]);
    }

    #[test]
    fn update_keeps_creation_date_and_unset_fields() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(TASKS_FILE);
        let mut i = input("bee2link", "Relancer EY");
        i.waiting_on = Some("EY".into());
        let t = upsert(&p, i, 100).unwrap();
        let mut edit = input("bee2link", "Relancer EY sur Sage 1000");
        edit.id = Some(t.id.clone());
        let u = upsert(&p, edit, 200).unwrap();
        assert_eq!(u.created_ms, 100);
        assert_eq!(u.updated_ms, 200);
        assert_eq!(u.title, "Relancer EY sur Sage 1000");
        assert_eq!(u.waiting_on.as_deref(), Some("EY"), "not erased by an edit that omits it");
        assert_eq!(load(&p).unwrap().len(), 1);
    }

    #[test]
    fn empty_title_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        assert!(upsert(&dir.path().join(TASKS_FILE), input("p", "   "), 1).is_err());
    }

    #[test]
    fn done_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(TASKS_FILE);
        let t = upsert(&p, input("p", "x"), 1).unwrap();
        let d = set_done(&p, &t.id, true, 5).unwrap();
        assert_eq!((d.status.as_str(), d.done_ms), (STATUS_DONE, Some(5)));
        let r = set_done(&p, &t.id, false, 6).unwrap();
        assert_eq!((r.status.as_str(), r.done_ms), (STATUS_TODO, None));
        assert!(set_done(&p, "nope", true, 7).is_err());
    }

    #[test]
    fn delete_removes_only_that_task() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(TASKS_FILE);
        let a = upsert(&p, input("p", "a"), 1).unwrap();
        let b = upsert(&p, input("p", "b"), 1).unwrap();
        delete(&p, &a.id).unwrap();
        assert_eq!(load(&p).unwrap(), vec![b]);
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_wipe() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(TASKS_FILE);
        std::fs::write(&p, "{broken").unwrap();
        assert!(load(&p).is_err());
        assert!(upsert(&p, input("p", "x"), 1).is_err(), "must not overwrite a file it cannot read");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{broken");
    }
}
