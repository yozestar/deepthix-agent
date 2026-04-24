use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

use crate::storage;

/// A user-opened project (folder).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub last_opened_unix_ms: u64,
}

/// What we persist to ~/.deepthix/projects.json.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectsFile {
    pub projects: Vec<Project>,
    pub active_project_id: Option<String>,
}

/// Mutex-guarded app state. Tauri stores this via `app.manage()`.
pub struct AppState {
    inner: Mutex<ProjectsFile>,
    persist_path: PathBuf,
}

impl AppState {
    /// Load from `persist_path`; if absent, start empty.
    pub fn load(persist_path: PathBuf) -> std::io::Result<Self> {
        let inner = storage::read_json::<ProjectsFile>(&persist_path)?.unwrap_or_default();
        Ok(Self { inner: Mutex::new(inner), persist_path })
    }

    /// Snapshot the current state.
    pub fn snapshot(&self) -> ProjectsFile {
        self.inner.lock().unwrap().clone()
    }

    /// Add a project (idempotent on `path`). Sets the new project as active.
    /// Returns the inserted-or-existing project.
    pub fn add(&self, path: PathBuf) -> std::io::Result<Project> {
        let mut state = self.inner.lock().unwrap();
        if let Some(existing) = state.projects.iter().find(|p| p.path == path).cloned() {
            state.active_project_id = Some(existing.id.clone());
            self.write_locked(&state)?;
            return Ok(existing);
        }
        let project = Project {
            id: format!("{:x}", project_hash(&path)),
            name: path.file_name().and_then(|n| n.to_str()).unwrap_or("project").to_string(),
            path,
            last_opened_unix_ms: now_unix_ms(),
        };
        state.projects.push(project.clone());
        state.active_project_id = Some(project.id.clone());
        self.write_locked(&state)?;
        Ok(project)
    }

    /// Switch the active project. No-op if id not in list.
    pub fn switch(&self, id: &str) -> std::io::Result<bool> {
        let mut state = self.inner.lock().unwrap();
        if !state.projects.iter().any(|p| p.id == id) {
            return Ok(false);
        }
        state.active_project_id = Some(id.to_string());
        if let Some(p) = state.projects.iter_mut().find(|p| p.id == id) {
            p.last_opened_unix_ms = now_unix_ms();
        }
        self.write_locked(&state)?;
        Ok(true)
    }

    /// Remove a project. If it was active, active becomes None.
    pub fn remove(&self, id: &str) -> std::io::Result<bool> {
        let mut state = self.inner.lock().unwrap();
        let before = state.projects.len();
        state.projects.retain(|p| p.id != id);
        if state.projects.len() == before {
            return Ok(false);
        }
        if state.active_project_id.as_deref() == Some(id) {
            state.active_project_id = None;
        }
        self.write_locked(&state)?;
        Ok(true)
    }

    fn write_locked(&self, state: &ProjectsFile) -> std::io::Result<()> {
        storage::write_json(&self.persist_path, state)
    }
}

fn project_hash(path: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    hasher.finish()
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fixture() -> (tempfile::TempDir, AppState) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("projects.json");
        let state = AppState::load(path).unwrap();
        (dir, state)
    }

    #[test]
    fn loads_empty_when_no_file() {
        let (_dir, state) = fixture();
        let snap = state.snapshot();
        assert!(snap.projects.is_empty());
        assert!(snap.active_project_id.is_none());
    }

    #[test]
    fn add_creates_persists_and_activates() {
        let (_dir, state) = fixture();
        let project_dir = tempdir().unwrap();
        let p = state.add(project_dir.path().to_path_buf()).unwrap();
        let snap = state.snapshot();
        assert_eq!(snap.projects.len(), 1);
        assert_eq!(snap.active_project_id, Some(p.id.clone()));
        assert_eq!(p.name, project_dir.path().file_name().unwrap().to_str().unwrap());
    }

    #[test]
    fn add_idempotent_on_path() {
        let (_dir, state) = fixture();
        let project_dir = tempdir().unwrap();
        let p1 = state.add(project_dir.path().to_path_buf()).unwrap();
        let p2 = state.add(project_dir.path().to_path_buf()).unwrap();
        assert_eq!(p1.id, p2.id);
        assert_eq!(state.snapshot().projects.len(), 1);
    }

    #[test]
    fn switch_changes_active() {
        let (_dir, state) = fixture();
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let pa = state.add(a.path().to_path_buf()).unwrap();
        let pb = state.add(b.path().to_path_buf()).unwrap();
        assert_eq!(state.snapshot().active_project_id, Some(pb.id.clone()));
        let ok = state.switch(&pa.id).unwrap();
        assert!(ok);
        assert_eq!(state.snapshot().active_project_id, Some(pa.id));
    }

    #[test]
    fn switch_unknown_id_returns_false() {
        let (_dir, state) = fixture();
        let ok = state.switch("nonexistent").unwrap();
        assert!(!ok);
    }

    #[test]
    fn remove_deletes_and_clears_active() {
        let (_dir, state) = fixture();
        let project_dir = tempdir().unwrap();
        let p = state.add(project_dir.path().to_path_buf()).unwrap();
        assert_eq!(state.snapshot().active_project_id, Some(p.id.clone()));
        let ok = state.remove(&p.id).unwrap();
        assert!(ok);
        assert!(state.snapshot().projects.is_empty());
        assert!(state.snapshot().active_project_id.is_none());
    }

    #[test]
    fn persists_across_reload() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("projects.json");
        let project_dir = tempdir().unwrap();
        {
            let state = AppState::load(path.clone()).unwrap();
            state.add(project_dir.path().to_path_buf()).unwrap();
        }
        let state = AppState::load(path).unwrap();
        assert_eq!(state.snapshot().projects.len(), 1);
        assert!(state.snapshot().active_project_id.is_some());
    }
}
