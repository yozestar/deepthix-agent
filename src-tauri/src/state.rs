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
    /// Pinned at the top of the project list, in pin order. None = not pinned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at_ms: Option<u64>,
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

    /// Re-read `projects.json` from disk (after an import replaced it).
    pub fn reload(&self) -> std::io::Result<()> {
        let fresh = storage::read_json::<ProjectsFile>(&self.persist_path)?.unwrap_or_default();
        *self.inner.lock().unwrap() = fresh;
        Ok(())
    }

    /// Snapshot the current state.
    pub fn snapshot(&self) -> ProjectsFile {
        self.inner.lock().unwrap().clone()
    }

    /// Add a project (idempotent on `path`). Sets the new project as active.
    /// Returns the inserted-or-existing project.
    pub fn add(&self, path: PathBuf) -> std::io::Result<Project> {
        let mut state = self.inner.lock().unwrap();
        if let Some(idx) = state.projects.iter().position(|p| p.path == path) {
            state.projects[idx].last_opened_unix_ms = now_unix_ms();
            let existing = state.projects[idx].clone();
            state.active_project_id = Some(existing.id.clone());
            self.write_locked(&state)?;
            return Ok(existing);
        }
        let project = Project {
            id: format!("{:x}", project_hash(&path)),
            name: path.file_name().and_then(|n| n.to_str()).unwrap_or("project").to_string(),
            path,
            last_opened_unix_ms: now_unix_ms(),
            pinned_at_ms: None,
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

    /// Rename a project by id. Returns true if a project was updated, false
    /// if no project matched the id.
    pub fn rename(&self, id: &str, name: String) -> std::io::Result<bool> {
        let mut state = self.inner.lock().unwrap();
        let Some(project) = state.projects.iter_mut().find(|p| p.id == id) else {
            tracing::warn!(target: "deepthix::state", %id, "rename: id not found");
            return Ok(false);
        };
        tracing::info!(target: "deepthix::state", %id, old = %project.name, new = %name, "rename");
        project.name = name;
        self.write_locked(&state)?;
        Ok(true)
    }

    /// Pin (keeps its first pin date) or unpin a project. False if unknown id.
    pub fn set_pinned(&self, id: &str, pinned: bool) -> std::io::Result<bool> {
        let mut state = self.inner.lock().unwrap();
        let Some(project) = state.projects.iter_mut().find(|p| p.id == id) else {
            return Ok(false);
        };
        project.pinned_at_ms = match (pinned, project.pinned_at_ms) {
            (true, Some(at)) => Some(at),
            (true, None) => Some(now_unix_ms()),
            (false, _) => None,
        };
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

/// Public form of the project-id computation. Same input → same id, so
/// pty.rs can derive the dashboard path from the spawn cwd without having
/// to plumb the id through every call site.
///
/// The id of a project already in projects.json wins: ids are only hashed
/// once, when the project is added, so a list moved from another machine
/// (Windows → Mac) keeps its old ids while the paths changed. Hashing the
/// new path would give conversations an id no project has (their tasks
/// and dashboard would land under an unknown project).
pub fn project_id_for_path(path: &Path) -> String {
    storage::deepthix_dir()
        .ok()
        .and_then(|d| storage::read_json::<ProjectsFile>(&d.join("projects.json")).ok().flatten())
        .and_then(|f| stored_project_id(&f.projects, path))
        .unwrap_or_else(|| format!("{:x}", project_hash(path)))
}

/// The project whose folder is `path`, else the deepest one containing it.
fn stored_project_id(projects: &[Project], path: &Path) -> Option<String> {
    if let Some(p) = projects.iter().find(|p| p.path == path) {
        return Some(p.id.clone());
    }
    projects
        .iter()
        .filter(|p| !p.path.as_os_str().is_empty() && path.starts_with(&p.path))
        .max_by_key(|p| p.path.components().count())
        .map(|p| p.id.clone())
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

    fn proj(id: &str, path: &str) -> Project {
        Project { id: id.into(), path: PathBuf::from(path), name: id.into(), last_opened_unix_ms: 0, pinned_at_ms: None }
    }

    #[test]
    fn stored_id_wins_over_the_path_hash() {
        // Ids hashed on Windows, paths later rewritten for the Mac.
        let list = vec![proj("b6d2", "/Users/ia/Dev/claude_agent"), proj("9d8d", "/Users/ia/Dev/bee2link")];
        assert_eq!(stored_project_id(&list, Path::new("/Users/ia/Dev/bee2link")).as_deref(), Some("9d8d"));
        assert_eq!(
            stored_project_id(&list, Path::new("/Users/ia/Dev/claude_agent/webview-ui")).as_deref(),
            Some("b6d2"),
            "a sub-folder belongs to its project"
        );
        assert_eq!(stored_project_id(&list, Path::new("/Users/ia/Dev/claude")), None, "prefix of a name is not a sub-folder");
        assert_eq!(stored_project_id(&list, Path::new("/tmp/x")), None);
    }

    #[test]
    fn deepest_containing_project_wins() {
        let list = vec![proj("dev", "/Users/ia/Dev"), proj("app", "/Users/ia/Dev/app")];
        assert_eq!(stored_project_id(&list, Path::new("/Users/ia/Dev/app/src")).as_deref(), Some("app"));
    }

    #[test]
    fn pin_persists_keeps_its_date_and_unpins() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("projects.json");
        let state = AppState::load(path.clone()).unwrap();
        let p = state.add(dir.path().join("bee2link")).unwrap();
        assert!(state.set_pinned(&p.id, true).unwrap());
        let first = state.snapshot().projects[0].pinned_at_ms;
        assert!(first.is_some());
        state.set_pinned(&p.id, true).unwrap();
        assert_eq!(state.snapshot().projects[0].pinned_at_ms, first, "re-pinning keeps its place");
        let reloaded = AppState::load(path.clone()).unwrap();
        assert_eq!(reloaded.snapshot().projects[0].pinned_at_ms, first);
        state.set_pinned(&p.id, false).unwrap();
        assert_eq!(AppState::load(path).unwrap().snapshot().projects[0].pinned_at_ms, None);
        assert!(!state.set_pinned("nope", true).unwrap());
    }

    #[test]
    fn older_projects_file_without_pins_loads() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("projects.json");
        std::fs::write(&path, r#"{"projects":[{"id":"a","path":"/x","name":"x","last_opened_unix_ms":1}],"active_project_id":null}"#).unwrap();
        assert_eq!(AppState::load(path).unwrap().snapshot().projects[0].pinned_at_ms, None);
    }

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
    fn rename_changes_name_and_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("projects.json");
        let project_dir = tempdir().unwrap();
        let id = {
            let state = AppState::load(path.clone()).unwrap();
            let p = state.add(project_dir.path().to_path_buf()).unwrap();
            let ok = state.rename(&p.id, "My Renamed Project".to_string()).unwrap();
            assert!(ok, "rename returned true on existing id");
            assert_eq!(state.snapshot().projects[0].name, "My Renamed Project");
            p.id
        };
        // Reload from disk to verify persistence.
        let state = AppState::load(path).unwrap();
        let snap = state.snapshot();
        let p = snap.projects.iter().find(|p| p.id == id).unwrap();
        assert_eq!(p.name, "My Renamed Project");
    }

    #[test]
    fn rename_unknown_id_returns_false() {
        let (_dir, state) = fixture();
        let ok = state.rename("nonexistent", "whatever".to_string()).unwrap();
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
    fn add_existing_path_refreshes_last_opened() {
        let (_dir, state) = fixture();
        let project_dir = tempdir().unwrap();
        let p1 = state.add(project_dir.path().to_path_buf()).unwrap();
        // Sleep at least 2ms so the timestamp can change measurably.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let p2 = state.add(project_dir.path().to_path_buf()).unwrap();
        assert_eq!(p1.id, p2.id, "id stable across re-add");
        assert!(
            p2.last_opened_unix_ms > p1.last_opened_unix_ms,
            "last_opened bumped: p1={} p2={}",
            p1.last_opened_unix_ms,
            p2.last_opened_unix_ms
        );
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
