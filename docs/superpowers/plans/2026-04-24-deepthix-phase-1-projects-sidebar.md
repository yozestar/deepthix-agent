# Deepthix Agent — Phase 1: Projects + Sidebar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can click "Open Folder", pick a project directory, see it added to a list of projects in a left sidebar, switch between projects (with the active project's file tree showing in the same sidebar), and have all of this persisted across restarts at `~/.deepthix/projects.json`.

**Architecture:** Rust commands handle the native macOS folder dialog (via `tauri-plugin-dialog`), JSON persistence to `~/.deepthix/projects.json`, and synchronous filesystem reads for the file tree. The webview gets typed `invoke()` wrappers (`webview-ui/src/tauri/commands.ts`) and a `useProjects` hook. UI lives in three new components: `ProjectList`, `FileTree`, `Sidebar` (the latter composing the first two). `App.tsx` is wrapped to put `Sidebar` on the left, the existing pixel-art canvas in the main area. Live file-watching is **out of scope** for this phase — the tree refreshes on project switch and via an explicit refresh button. Watching lands in Phase 4 (when JSONL watchers go in alongside the agent backend).

**Tech Stack:** Tauri 2.x, `tauri-plugin-dialog`, Rust `serde_json` + `dirs`, React 19 + TypeScript, the existing pixel-art CSS aesthetic from `webview-ui/src/index.css` (CSS variables `--pixel-bg`, `--pixel-border`, etc.).

**Spec:** [`../specs/2026-04-24-deepthix-agent-design.md`](../specs/2026-04-24-deepthix-agent-design.md) — see sections "UI Layout > Sidebar gauche", "Architecture > IPC contract — Commands", "Storage".
**Master plan:** [`./2026-04-24-deepthix-master-plan.md`](./2026-04-24-deepthix-master-plan.md)
**Previous phase:** [`./2026-04-24-deepthix-phase-0-bootstrap.md`](./2026-04-24-deepthix-phase-0-bootstrap.md) (tag `deepthix-phase-0-done`)

**Working directory for ALL commands:** `/Users/rubenperez/Sites/localhost/deepthix-agent`

---

## File Structure (locked here)

| File | Responsibility |
|------|----------------|
| `src-tauri/src/storage.rs` | Atomic read/write of JSON files under `~/.deepthix/`. Generic over the payload type. |
| `src-tauri/src/state.rs` | `AppState`: holds projects list + active project ID, mutex-guarded. Loads from / saves to `~/.deepthix/projects.json` via `storage.rs`. |
| `src-tauri/src/commands/mod.rs` | Re-exports the command modules. |
| `src-tauri/src/commands/projects.rs` | Tauri commands: `open_folder`, `add_project`, `list_projects`, `switch_project`, `remove_project`. |
| `src-tauri/src/commands/fs.rs` | Tauri command: `list_dir` (returns one level of entries; not recursive — frontend lazy-expands). |
| `src-tauri/src/lib.rs` | (modified) Initialize `AppState`, register `tauri-plugin-dialog`, register all commands via `.invoke_handler(...)`. |
| `src-tauri/Cargo.toml` | (modified) Add `tauri-plugin-dialog`, `serde`, `serde_json`, `tempfile` (dev). |
| `src-tauri/capabilities/default.json` | (modified) Grant the `dialog:default` permission and our custom command permissions. |
| `webview-ui/src/tauri/commands.ts` | Typed `invoke()` wrappers — one function per Rust command. Logs every call. |
| `webview-ui/src/tauri/events.ts` | Typed `listen()` wrappers (skeleton for now; we only fire `project_switched` from Rust in this phase). |
| `webview-ui/src/tauri/types.ts` | Shared TS types: `Project`, `FileEntry`. Mirror Rust's `serde` types. |
| `webview-ui/src/hooks/useProjects.ts` | React hook: loads project list + active ID on mount, exposes `addProject`, `switchProject`, `removeProject`. |
| `webview-ui/src/hooks/useFileTree.ts` | React hook: loads `list_dir` for a given root, supports lazy-expand of subdirs. |
| `webview-ui/src/components/Sidebar.tsx` | Container: renders `ProjectList` (top) + `FileTree` (bottom) with a resizable divider. |
| `webview-ui/src/components/ProjectList.tsx` | Renders the project list with the active project highlighted, an `+ Open Folder` button, and a context-menu / hover X to remove. |
| `webview-ui/src/components/FileTree.tsx` | Renders the active project's file tree using `useFileTree`. |
| `webview-ui/src/components/Welcome.tsx` | Splash / no-projects screen with a single big `Open Folder` button. Shown when projects list is empty. |
| `webview-ui/src/App.tsx` | (modified) Wrap the existing pixel-office in a 2-column flex layout: `<Sidebar/>` on the left, existing main content on the right. Show `<Welcome/>` when no projects. |
| `webview-ui/src/tauri/commands.ts` integration tests in `webview-ui/test/commands.test.ts` | Lightweight: assert the wrapper functions exist and pass through args correctly. |

**Why `useFileTree` is its own hook:** the file tree state (expanded paths, loaded children) is independent of project list state and may grow (search filtering, refresh, watch in later phases). Keeping it separate avoids coupling.

**Why `Welcome` is its own component:** branching the no-projects case in `App.tsx` keeps the main layout clean and lets us style the splash differently.

---

## Pre-flight

- [ ] **Step P1: Verify Phase 0 is checked in to main**

```bash
cd /Users/rubenperez/Sites/localhost/deepthix-agent
git branch --show-current
git tag --list deepthix-phase-0-done
git log --oneline -5
```

Expected: branch `main` (or willing to switch to `phase-1/projects-sidebar` after this step), tag `deepthix-phase-0-done` exists, recent commits include `Merge Phase 0 — Bootstrap & Tauri shell`.

- [ ] **Step P2: Create the phase-1 branch**

```bash
git checkout main
git pull --ff-only 2>/dev/null || true   # no remote yet, that's fine
git checkout -b phase-1/projects-sidebar
git branch --show-current
```

Expected: `phase-1/projects-sidebar`.

- [ ] **Step P3: Confirm the Phase 0 baseline still works**

```bash
cd src-tauri && cargo build && cd ..
(cd webview-ui && npm run build)
```

Both should succeed. (We're not running `npm run dev` here — Phase 0 already validated that.)

---

## Task 1: Add Tauri plugin-dialog + serde deps

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1.1: Add the Cargo deps**

Open `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/Cargo.toml`. In the `[dependencies]` section, add (next to existing entries — preserve `tauri = "2"`, `tracing`, `tracing-subscriber`, `tracing-appender`, `dirs`):

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri-plugin-dialog = "2"
```

In the `[dev-dependencies]` section (create it if absent), add:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 1.2: Build to confirm crates resolve**

```bash
cd src-tauri && cargo build && cd ..
```

Expected: clean build (downloads new crates the first time — be patient).

- [ ] **Step 1.3: Grant the dialog permission to the main window**

Open `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/capabilities/default.json`. The current contents look like:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

Add `"dialog:default"` to the `permissions` array:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": ["core:default", "dialog:default"]
}
```

- [ ] **Step 1.4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/capabilities/default.json
git commit -m "$(cat <<'EOF'
Add tauri-plugin-dialog + serde deps for project picker

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Storage module — atomic JSON read/write under ~/.deepthix/

**Files:**
- Create: `src-tauri/src/storage.rs`
- Test inline at the bottom of `storage.rs` (Rust convention).

- [ ] **Step 2.1: Write the failing tests**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/storage.rs` with the test module first:

```rust
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

/// Reads a JSON file at `path`, deserializing to `T`. Returns `Ok(None)` if
/// the file doesn't exist; `Err` for any other I/O or parse failure.
pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> std::io::Result<Option<T>> {
    todo!("implemented in step 2.3")
}

/// Atomically writes `value` as pretty-printed JSON to `path`. Creates parent
/// dirs if needed. Uses `<path>.tmp` + rename so a crash mid-write leaves the
/// previous file intact.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    todo!("implemented in step 2.3")
}

/// Returns `~/.deepthix/`, creating it if absent.
pub fn deepthix_dir() -> std::io::Result<PathBuf> {
    todo!("implemented in step 2.3")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::tempdir;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Foo {
        n: i32,
        s: String,
    }

    #[test]
    fn read_json_returns_none_when_file_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing.json");
        let result: Option<Foo> = read_json(&path).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("foo.json");
        let value = Foo { n: 42, s: "hello".into() };
        write_json(&path, &value).unwrap();
        let loaded: Option<Foo> = read_json(&path).unwrap();
        assert_eq!(loaded, Some(value));
    }

    #[test]
    fn write_creates_parent_dirs() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a/b/c/foo.json");
        let value = Foo { n: 1, s: "x".into() };
        write_json(&nested, &value).unwrap();
        assert!(nested.exists());
    }

    #[test]
    fn write_is_atomic_via_tmp_rename() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("foo.json");
        // Pre-existing file with old contents.
        std::fs::write(&path, br#"{"n":1,"s":"old"}"#).unwrap();
        let new_value = Foo { n: 2, s: "new".into() };
        write_json(&path, &new_value).unwrap();
        // No leftover .tmp.
        let entries: Vec<_> = std::fs::read_dir(dir.path()).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(!entries.iter().any(|n| n.ends_with(".tmp")), "leftover tmp: {:?}", entries);
        let loaded: Foo = read_json(&path).unwrap().unwrap();
        assert_eq!(loaded.n, 2);
    }

    #[test]
    fn deepthix_dir_is_under_home() {
        let path = deepthix_dir().unwrap();
        assert!(path.ends_with(".deepthix"), "got {:?}", path);
        assert!(path.is_dir());
    }
}
```

Add `mod storage;` to `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/lib.rs` (top of file, near `mod log;`).

- [ ] **Step 2.2: Run tests, confirm they fail**

```bash
cd src-tauri && cargo test --lib storage:: 2>&1 | tail -30 && cd ..
```

Expected: 5 test failures, all hitting `not yet implemented` from `todo!()`.

- [ ] **Step 2.3: Implement storage.rs**

Replace the three `todo!()` bodies in `src-tauri/src/storage.rs` with:

```rust
pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> std::io::Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value = serde_json::from_slice(&bytes).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, e)
            })?;
            Ok(Some(value))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e)
    })?;
    let tmp = path.with_extension(
        path.extension().and_then(|e| e.to_str()).map(|e| format!("{e}.tmp")).unwrap_or_else(|| "tmp".into())
    );
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, path)?;
    tracing::debug!(target: "deepthix::storage", ?path, bytes = bytes.len(), "wrote json");
    Ok(())
}

pub fn deepthix_dir() -> std::io::Result<PathBuf> {
    let dir = dirs::home_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?
        .join(".deepthix");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
```

- [ ] **Step 2.4: Run tests, confirm pass**

```bash
cd src-tauri && cargo test --lib storage:: 2>&1 | tail -20 && cd ..
```

Expected: 5 passed; 0 failed.

- [ ] **Step 2.5: Commit**

```bash
git add src-tauri/src/storage.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Add storage module: atomic read/write of JSON under ~/.deepthix/

read_json returns None for missing files (so callers can default).
write_json writes to <path>.tmp then renames atomically so a crash
mid-write can't truncate the previous contents.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Project model + AppState

**Files:**
- Create: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs` to declare `mod state;` and initialize the state.

- [ ] **Step 3.1: Write the failing tests**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/state.rs`:

```rust
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
```

Add `mod state;` near the top of `src-tauri/src/lib.rs` (next to `mod log;`, `mod storage;`).

- [ ] **Step 3.2: Run tests, confirm pass**

The implementation is included above (no `todo!()` here — the module is small enough that splitting into stub-then-impl isn't worth the round-trip).

```bash
cd src-tauri && cargo test --lib state:: 2>&1 | tail -20 && cd ..
```

Expected: 7 passed; 0 failed.

- [ ] **Step 3.3: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Add Project model + AppState (mutex-guarded, persisted)

Project: id, path, name, last_opened_unix_ms.
AppState exposes add/switch/remove/snapshot. add is idempotent on
path and activates the project. Every mutation writes the JSON
file via the atomic storage helper, so a crash leaves the previous
state intact.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Tauri commands — projects

**Files:**
- Create: `src-tauri/src/commands/mod.rs`
- Create: `src-tauri/src/commands/projects.rs`

- [ ] **Step 4.1: Create the module re-export**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/commands/mod.rs`:

```rust
pub mod projects;
pub mod fs;
```

(`fs.rs` lands in Task 5 — the empty re-export is fine for now since cargo will fail until the file exists. We add the file in Task 5.)

To keep cargo happy until then, create a stub `src-tauri/src/commands/fs.rs`:

```rust
// Implemented in Task 5.
```

- [ ] **Step 4.2: Implement projects commands**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/commands/projects.rs`:

```rust
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
    rx.recv().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_project(state: State<'_, AppState>, path: PathBuf) -> Result<Project, String> {
    tracing::info!(target: "deepthix::commands", ?path, "add_project");
    state.add(path).map_err(|e| e.to_string())
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
```

- [ ] **Step 4.3: Add `mod commands;` to lib.rs and ensure compile**

In `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/lib.rs`, add `mod commands;` near the other module declarations.

```bash
cd src-tauri && cargo build && cd ..
```

Expected: clean compile (warnings about unused commands are OK — they'll be used after Task 6).

- [ ] **Step 4.4: Commit**

```bash
git add src-tauri/src/commands/
git add src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Add Tauri commands for projects (open_folder, add, list, switch, remove)

open_folder uses tauri-plugin-dialog's pick_folder. switch_project
emits a `project_switched` event so the webview can refresh
project-scoped state without polling.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Tauri command — list_dir

**Files:**
- Modify: `src-tauri/src/commands/fs.rs` (currently a stub from Task 4)

- [ ] **Step 5.1: Write tests + implementation**

Replace the stub at `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/commands/fs.rs` with:

```rust
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub is_hidden: bool,
}

const EXCLUDE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "target",
    ".deepthix",
    ".next",
    ".turbo",
    ".cache",
];

#[tauri::command]
pub fn list_dir(path: PathBuf) -> Result<Vec<FileEntry>, String> {
    tracing::debug!(target: "deepthix::commands", ?path, "list_dir");
    list_dir_inner(&path).map_err(|e| e.to_string())
}

fn list_dir_inner(path: &Path) -> std::io::Result<Vec<FileEntry>> {
    let mut entries: Vec<FileEntry> = std::fs::read_dir(path)?
        .filter_map(|res| {
            let entry = res.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let entry_path = entry.path();
            let is_dir = entry.file_type().ok()?.is_dir();
            let is_hidden = name.starts_with('.');
            if is_dir && EXCLUDE_DIRS.contains(&name.as_str()) {
                return None;
            }
            Some(FileEntry { name, path: entry_path, is_dir, is_hidden })
        })
        .collect();
    // Dirs first, then files; alphabetical within each group.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn lists_files_and_dirs_with_dirs_first() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("zebra.txt"), b"").unwrap();
        std::fs::write(dir.path().join("apple.txt"), b"").unwrap();
        std::fs::create_dir(dir.path().join("subdir")).unwrap();
        let entries = list_dir_inner(dir.path()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["subdir", "apple.txt", "zebra.txt"]);
    }

    #[test]
    fn excludes_node_modules_and_git_etc() {
        let dir = tempdir().unwrap();
        for excluded in &["node_modules", ".git", "dist", "target", ".deepthix"] {
            std::fs::create_dir(dir.path().join(excluded)).unwrap();
        }
        std::fs::create_dir(dir.path().join("src")).unwrap();
        let entries = list_dir_inner(dir.path()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src"]);
    }

    #[test]
    fn marks_hidden_dotfiles_but_keeps_them() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), b"").unwrap();
        std::fs::write(dir.path().join("README.md"), b"").unwrap();
        let entries = list_dir_inner(dir.path()).unwrap();
        assert_eq!(entries.len(), 2);
        let env = entries.iter().find(|e| e.name == ".env").unwrap();
        assert!(env.is_hidden);
        let readme = entries.iter().find(|e| e.name == "README.md").unwrap();
        assert!(!readme.is_hidden);
    }

    #[test]
    fn returns_err_when_path_does_not_exist() {
        let result = list_dir_inner(Path::new("/definitely/does/not/exist/xyz123"));
        assert!(result.is_err());
    }
}
```

- [ ] **Step 5.2: Run the tests**

```bash
cd src-tauri && cargo test --lib commands::fs:: 2>&1 | tail -20 && cd ..
```

Expected: 4 passed; 0 failed.

- [ ] **Step 5.3: Commit**

```bash
git add src-tauri/src/commands/fs.rs
git commit -m "$(cat <<'EOF'
Add list_dir command: one level deep, dirs-first, excludes vendor dirs

Excludes node_modules, .git, dist, target, .deepthix, .next,
.turbo, .cache by default. Hidden files (dotfiles) are returned
with is_hidden=true so the frontend can de-emphasize them but
still let the user expand them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire commands + state + plugin into lib.rs

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 6.1: Update lib.rs**

Replace the contents of `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/lib.rs` with:

```rust
mod commands;
mod log;
mod state;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _log_guard = log::init();
    tracing::info!(target: "deepthix::boot", version = env!("CARGO_PKG_VERSION"), "starting Deepthix Agent");

    let projects_path = match storage::deepthix_dir() {
        Ok(dir) => dir.join("projects.json"),
        Err(e) => {
            tracing::error!(target: "deepthix::boot", error = %e, "failed to resolve ~/.deepthix/");
            std::process::exit(1);
        }
    };
    let app_state = match state::AppState::load(projects_path.clone()) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(target: "deepthix::boot", error = %e, path = ?projects_path, "failed to load projects.json");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::projects::open_folder,
            commands::projects::add_project,
            commands::projects::list_projects,
            commands::projects::switch_project,
            commands::projects::remove_project,
            commands::fs::list_dir,
        ])
        .setup(|_app| {
            tracing::info!(target: "deepthix::boot", "tauri setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 6.2: Build + smoke**

```bash
cd src-tauri && cargo build && cd ..
```

Expected: clean compile.

- [ ] **Step 6.3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Wire AppState + dialog plugin + project/fs commands into Tauri builder

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Frontend — typed Tauri command/event wrappers

**Files:**
- Create: `webview-ui/src/tauri/types.ts`
- Create: `webview-ui/src/tauri/commands.ts`
- Create: `webview-ui/src/tauri/events.ts`
- Create: `webview-ui/test/commands.test.ts`

- [ ] **Step 7.1: Types**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/tauri/types.ts`:

```ts
// Mirror of Rust's serde-serialized types from src-tauri/src/state.rs
// and src-tauri/src/commands/fs.rs.

export interface Project {
  id: string;
  path: string;
  name: string;
  last_opened_unix_ms: number;
}

export interface ProjectsFile {
  projects: Project[];
  active_project_id: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
}

export interface SwitchResult {
  ok: boolean;
}
```

- [ ] **Step 7.2: Command wrappers**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/tauri/commands.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';

import type { FileEntry, Project, ProjectsFile, SwitchResult } from './types';

function log(name: string, args?: unknown): void {
  // eslint-disable-next-line no-console
  console.debug('[Deepthix][cmd]', name, args ?? '');
}

export async function openFolder(): Promise<string | null> {
  log('openFolder');
  return await invoke<string | null>('open_folder');
}

export async function addProject(path: string): Promise<Project> {
  log('addProject', { path });
  return await invoke<Project>('add_project', { path });
}

export async function listProjects(): Promise<ProjectsFile> {
  log('listProjects');
  return await invoke<ProjectsFile>('list_projects');
}

export async function switchProject(id: string): Promise<SwitchResult> {
  log('switchProject', { id });
  return await invoke<SwitchResult>('switch_project', { id });
}

export async function removeProject(id: string): Promise<boolean> {
  log('removeProject', { id });
  return await invoke<boolean>('remove_project', { id });
}

export async function listDir(path: string): Promise<FileEntry[]> {
  log('listDir', { path });
  return await invoke<FileEntry[]>('list_dir', { path });
}
```

- [ ] **Step 7.3: Event wrappers**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/tauri/events.ts`:

```ts
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

function log(name: string, payload?: unknown): void {
  // eslint-disable-next-line no-console
  console.debug('[Deepthix][evt]', name, payload ?? '');
}

/** Fired when the active project changes (payload: project id). */
export async function onProjectSwitched(handler: (id: string) => void): Promise<UnlistenFn> {
  return await listen<string>('project_switched', (event) => {
    log('project_switched', event.payload);
    handler(event.payload);
  });
}
```

- [ ] **Step 7.4: Lightweight test**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/test/commands.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('command wrappers exist with expected signatures', async () => {
  const mod = await import('../src/tauri/commands.ts');
  assert.equal(typeof mod.openFolder, 'function');
  assert.equal(typeof mod.addProject, 'function');
  assert.equal(typeof mod.listProjects, 'function');
  assert.equal(typeof mod.switchProject, 'function');
  assert.equal(typeof mod.removeProject, 'function');
  assert.equal(typeof mod.listDir, 'function');
});
```

- [ ] **Step 7.5: Run tests + build**

```bash
cd webview-ui
npm test
npm run build
cd ..
```

Expected: test passes, build succeeds.

- [ ] **Step 7.6: Commit**

```bash
git add webview-ui/src/tauri/ webview-ui/test/commands.test.ts
git commit -m "$(cat <<'EOF'
Add typed Tauri command + event wrappers in webview

commands.ts exposes one async function per Rust #[tauri::command],
typed against the mirror in types.ts. events.ts has the listener
for project_switched (more events land in later phases).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Frontend — useProjects hook

**Files:**
- Create: `webview-ui/src/hooks/useProjects.ts`

- [ ] **Step 8.1: Implement the hook**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/hooks/useProjects.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';

import {
  addProject as cmdAddProject,
  listProjects as cmdListProjects,
  openFolder as cmdOpenFolder,
  removeProject as cmdRemoveProject,
  switchProject as cmdSwitchProject,
} from '../tauri/commands';
import { onProjectSwitched } from '../tauri/events';
import type { Project } from '../tauri/types';

export interface UseProjectsResult {
  projects: Project[];
  activeProjectId: string | null;
  activeProject: Project | null;
  loading: boolean;
  error: string | null;
  /** Opens the folder picker; if a folder is chosen, adds it as a project and activates it. */
  openAndAddProject: () => Promise<Project | null>;
  switchProject: (id: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const file = await cmdListProjects();
      setProjects(file.projects);
      setActiveProjectId(file.active_project_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useProjects] refresh failed', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sync active id from the Tauri-side event (covers cases where switch is
  // initiated from elsewhere — for Phase 1 only via switchProject below, but
  // future phases may switch from menus, hotkeys, etc.).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onProjectSwitched((id) => {
      setActiveProjectId(id);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const openAndAddProject = useCallback(async (): Promise<Project | null> => {
    setError(null);
    try {
      const path = await cmdOpenFolder();
      if (!path) return null;
      const project = await cmdAddProject(path);
      await refresh();
      return project;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useProjects] openAndAddProject failed', msg);
      setError(msg);
      return null;
    }
  }, [refresh]);

  const switchProject = useCallback(async (id: string): Promise<void> => {
    setError(null);
    try {
      await cmdSwitchProject(id);
      // The project_switched event handler will update activeProjectId.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useProjects] switchProject failed', msg);
      setError(msg);
    }
  }, []);

  const removeProject = useCallback(async (id: string): Promise<void> => {
    setError(null);
    try {
      await cmdRemoveProject(id);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useProjects] removeProject failed', msg);
      setError(msg);
    }
  }, [refresh]);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  return {
    projects,
    activeProjectId,
    activeProject,
    loading,
    error,
    openAndAddProject,
    switchProject,
    removeProject,
    refresh,
  };
}
```

- [ ] **Step 8.2: Build to confirm types**

```bash
cd webview-ui && npm run build && cd ..
```

Expected: build succeeds.

- [ ] **Step 8.3: Commit**

```bash
git add webview-ui/src/hooks/useProjects.ts
git commit -m "$(cat <<'EOF'
Add useProjects hook: load/add/switch/remove + project_switched listener

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Frontend — useFileTree hook

**Files:**
- Create: `webview-ui/src/hooks/useFileTree.ts`

- [ ] **Step 9.1: Implement the hook**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/hooks/useFileTree.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';

import { listDir } from '../tauri/commands';
import type { FileEntry } from '../tauri/types';

export interface FileTreeNode extends FileEntry {
  children?: FileTreeNode[];
  loading?: boolean;
}

export interface UseFileTreeResult {
  root: FileTreeNode | null;
  expanded: Set<string>;
  error: string | null;
  loading: boolean;
  toggle: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useFileTree(rootPath: string | null): UseFileTreeResult {
  const [root, setRoot] = useState<FileTreeNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!rootPath) {
      setRoot(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const children = await listDir(rootPath);
      const name = rootPath.split('/').filter(Boolean).pop() ?? rootPath;
      setRoot({
        name,
        path: rootPath,
        is_dir: true,
        is_hidden: false,
        children: children.map((c) => ({ ...c, children: c.is_dir ? undefined : [] })),
      });
      // Reset expansion to top level on refresh.
      setExpanded(new Set([rootPath]));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useFileTree] refresh failed', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async (path: string): Promise<void> => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    // Lazy-load children if needed.
    setRoot((prev) => {
      if (!prev) return prev;
      const target = findNode(prev, path);
      if (!target || !target.is_dir || target.children !== undefined) return prev;
      // Mark loading; actual fetch happens below.
      target.loading = true;
      return { ...prev };
    });
    try {
      const children = await listDir(path);
      setRoot((prev) => {
        if (!prev) return prev;
        const target = findNode(prev, path);
        if (target) {
          target.children = children.map((c) => ({ ...c, children: c.is_dir ? undefined : [] }));
          target.loading = false;
        }
        return { ...prev };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useFileTree] toggle failed', { path, msg });
      setError(msg);
    }
  }, []);

  return { root, expanded, error, loading, toggle, refresh };
}

function findNode(node: FileTreeNode, path: string): FileTreeNode | null {
  if (node.path === path) return node;
  if (!node.children) return null;
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}
```

- [ ] **Step 9.2: Build**

```bash
cd webview-ui && npm run build && cd ..
```

- [ ] **Step 9.3: Commit**

```bash
git add webview-ui/src/hooks/useFileTree.ts
git commit -m "$(cat <<'EOF'
Add useFileTree hook with lazy expand-on-click

Loads only the immediate children of the root on mount; expanding
a directory triggers a list_dir call for that path. Already-loaded
children are not re-fetched. Refresh resets expansion to the root.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Frontend — ProjectList component

**Files:**
- Create: `webview-ui/src/components/ProjectList.tsx`

- [ ] **Step 10.1: Implement**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/components/ProjectList.tsx`:

```tsx
import type { Project } from '../tauri/types';

interface Props {
  projects: Project[];
  activeProjectId: string | null;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
  onOpenFolder: () => void;
}

export function ProjectList({
  projects,
  activeProjectId,
  onSwitch,
  onRemove,
  onOpenFolder,
}: Props): React.JSX.Element {
  return (
    <div
      className="project-list"
      style={{
        background: 'var(--pixel-bg)',
        borderRight: '2px solid var(--pixel-border)',
        padding: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        fontFamily: 'inherit',
      }}
    >
      <div
        style={{
          fontSize: '10px',
          opacity: 0.7,
          letterSpacing: '0.1em',
          padding: '4px',
        }}
      >
        PROJECTS
      </div>
      {projects.length === 0 && (
        <div style={{ fontSize: '11px', opacity: 0.6, padding: '4px' }}>
          No projects yet.
        </div>
      )}
      {projects.map((p) => {
        const isActive = p.id === activeProjectId;
        return (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => onSwitch(p.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSwitch(p.id);
            }}
            style={{
              cursor: 'pointer',
              padding: '4px 6px',
              background: isActive ? 'var(--pixel-accent)' : 'transparent',
              color: isActive ? '#0a0a14' : 'inherit',
              border: isActive ? '2px solid var(--pixel-border)' : '2px solid transparent',
              boxShadow: isActive ? '2px 2px 0 #0a0a14' : 'none',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '6px',
            }}
            title={p.path}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden' }}>
              <span style={{ opacity: isActive ? 1 : 0 }}>●</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(p.id);
              }}
              aria-label={`Remove ${p.name}`}
              style={{
                background: 'transparent',
                color: 'inherit',
                border: 'none',
                cursor: 'pointer',
                opacity: 0.6,
                padding: '0 4px',
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onOpenFolder}
        style={{
          marginTop: '6px',
          padding: '6px 8px',
          background: 'transparent',
          color: 'inherit',
          border: '2px solid var(--pixel-border)',
          boxShadow: '2px 2px 0 #0a0a14',
          cursor: 'pointer',
          fontSize: '11px',
          fontFamily: 'inherit',
        }}
      >
        + Open Folder
      </button>
    </div>
  );
}
```

- [ ] **Step 10.2: Build**

```bash
cd webview-ui && npm run build && cd ..
```

- [ ] **Step 10.3: Commit**

```bash
git add webview-ui/src/components/ProjectList.tsx
git commit -m "$(cat <<'EOF'
Add ProjectList component (pixel-styled, switch + remove + add)

Active project is highlighted with the pixel-accent background +
2px border + 2px shadow (matches the rest of the app's aesthetic).
Per-row × button removes the project (with stopPropagation so it
doesn't also trigger switch). + Open Folder button at the bottom
opens the native folder picker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Frontend — FileTree component

**Files:**
- Create: `webview-ui/src/components/FileTree.tsx`

- [ ] **Step 11.1: Implement**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/components/FileTree.tsx`:

```tsx
import type { FileTreeNode, UseFileTreeResult } from '../hooks/useFileTree';

interface Props {
  tree: UseFileTreeResult;
}

export function FileTree({ tree }: Props): React.JSX.Element {
  const { root, expanded, error, loading, toggle, refresh } = tree;

  return (
    <div
      style={{
        background: 'var(--pixel-bg)',
        padding: '8px',
        flex: 1,
        overflow: 'auto',
        fontFamily: 'inherit',
        fontSize: '11px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '10px',
          opacity: 0.7,
          letterSpacing: '0.1em',
          padding: '4px',
        }}
      >
        <span>FILES</span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || !root}
          style={{
            background: 'transparent',
            color: 'inherit',
            border: 'none',
            cursor: 'pointer',
            opacity: 0.6,
            padding: '0 4px',
            fontSize: '10px',
          }}
          aria-label="Refresh file tree"
          title="Refresh"
        >
          ⟳
        </button>
      </div>
      {error && (
        <div style={{ color: '#ff6b6b', padding: '4px' }}>
          {error}
        </div>
      )}
      {loading && !root && <div style={{ opacity: 0.6, padding: '4px' }}>Loading…</div>}
      {!loading && !root && (
        <div style={{ opacity: 0.6, padding: '4px' }}>No project open.</div>
      )}
      {root && <Branch node={root} depth={0} expanded={expanded} onToggle={toggle} />}
    </div>
  );
}

function Branch({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}): React.JSX.Element {
  const isExpanded = expanded.has(node.path);
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (node.is_dir) onToggle(node.path);
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && node.is_dir) onToggle(node.path);
        }}
        style={{
          cursor: node.is_dir ? 'pointer' : 'default',
          opacity: node.is_hidden ? 0.55 : 1,
          padding: `2px 4px 2px ${4 + depth * 12}px`,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={node.path}
      >
        {node.is_dir ? (isExpanded ? '▾ ' : '▸ ') : '   '}
        {node.name}
        {node.loading && <span style={{ opacity: 0.5 }}> …</span>}
      </div>
      {node.is_dir && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <Branch
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 11.2: Build**

```bash
cd webview-ui && npm run build && cd ..
```

- [ ] **Step 11.3: Commit**

```bash
git add webview-ui/src/components/FileTree.tsx
git commit -m "$(cat <<'EOF'
Add FileTree component with lazy-expand directories

Top-level shows the project root + immediate children. Clicking a
directory triggers list_dir for that path (via useFileTree.toggle).
Hidden files (dotfiles) are de-emphasized but still listed. Refresh
button at the top.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Frontend — Sidebar + Welcome

**Files:**
- Create: `webview-ui/src/components/Sidebar.tsx`
- Create: `webview-ui/src/components/Welcome.tsx`

- [ ] **Step 12.1: Sidebar shell**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/components/Sidebar.tsx`:

```tsx
import type { UseFileTreeResult } from '../hooks/useFileTree';
import type { UseProjectsResult } from '../hooks/useProjects';

import { FileTree } from './FileTree';
import { ProjectList } from './ProjectList';

interface Props {
  projects: UseProjectsResult;
  fileTree: UseFileTreeResult;
}

export function Sidebar({ projects, fileTree }: Props): React.JSX.Element {
  return (
    <div
      style={{
        width: '220px',
        minWidth: '180px',
        background: 'var(--pixel-bg)',
        borderRight: '2px solid var(--pixel-border)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'inherit',
      }}
    >
      <ProjectList
        projects={projects.projects}
        activeProjectId={projects.activeProjectId}
        onSwitch={(id) => void projects.switchProject(id)}
        onRemove={(id) => void projects.removeProject(id)}
        onOpenFolder={() => void projects.openAndAddProject()}
      />
      <div
        style={{
          height: '2px',
          background: 'var(--pixel-border)',
          margin: '0',
        }}
      />
      <FileTree tree={fileTree} />
    </div>
  );
}
```

- [ ] **Step 12.2: Welcome screen**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/components/Welcome.tsx`:

```tsx
interface Props {
  onOpenFolder: () => void;
}

export function Welcome({ onOpenFolder }: Props): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '24px',
        background: 'var(--pixel-bg)',
        color: 'inherit',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ fontSize: '24px', letterSpacing: '0.05em' }}>Deepthix Agent</div>
      <div style={{ fontSize: '12px', opacity: 0.7, maxWidth: '320px', textAlign: 'center' }}>
        Open a folder to start your first project. Your agents will live in a pixel-art office,
        scoped to that project.
      </div>
      <button
        type="button"
        onClick={onOpenFolder}
        style={{
          padding: '12px 24px',
          fontSize: '14px',
          background: 'var(--pixel-accent)',
          color: '#0a0a14',
          border: '2px solid var(--pixel-border)',
          boxShadow: '4px 4px 0 #0a0a14',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        📂 Open Folder
      </button>
    </div>
  );
}
```

- [ ] **Step 12.3: Build**

```bash
cd webview-ui && npm run build && cd ..
```

- [ ] **Step 12.4: Commit**

```bash
git add webview-ui/src/components/Sidebar.tsx webview-ui/src/components/Welcome.tsx
git commit -m "$(cat <<'EOF'
Add Sidebar (ProjectList + FileTree) and Welcome splash screens

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Wire the new layout into App.tsx

**Files:**
- Modify: `webview-ui/src/App.tsx`

This is the trickiest step because pixel-agents' `App.tsx` is dense (~373 lines, the composition root for the office canvas + toolbar + modals). We DO NOT rewrite it; we wrap its existing return in a flex container with `<Sidebar/>` on the left.

- [ ] **Step 13.1: Read App.tsx and find its top-level return**

```bash
sed -n '1,30p' webview-ui/src/App.tsx
sed -n '/^ *return/,$p' webview-ui/src/App.tsx | head -40
```

Note where the existing `return (...)` lives and what its outermost element is. Pixel-agents' `App.tsx` returns a single `<div>` containing `<OfficeCanvas/>` + overlays.

- [ ] **Step 13.2: Add the Sidebar imports and hooks at the top of App()**

In `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/App.tsx`, add these imports near the existing ones:

```ts
import { Sidebar } from './components/Sidebar';
import { Welcome } from './components/Welcome';
import { useFileTree } from './hooks/useFileTree';
import { useProjects } from './hooks/useProjects';
```

Inside the `App()` function body, near the top (before the existing hooks like `useExtensionMessages`), add:

```ts
  const projects = useProjects();
  const fileTree = useFileTree(projects.activeProject?.path ?? null);
```

- [ ] **Step 13.3: Wrap the return in a flex layout**

Find the existing `return (` block. Change it from:

```tsx
return (
  <div style={{ /* existing styles */ }}>
    {/* existing children */}
  </div>
);
```

to:

```tsx
return (
  <div style={{ display: 'flex', height: '100vh', width: '100vw', background: 'var(--pixel-bg)' }}>
    <Sidebar projects={projects} fileTree={fileTree} />
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      {projects.projects.length === 0 ? (
        <Welcome onOpenFolder={() => void projects.openAndAddProject()} />
      ) : (
        <div style={{ /* COPY existing styles from the original outer div */ width: '100%', height: '100%' }}>
          {/* COPY existing children verbatim — OfficeCanvas, BottomToolbar, modals, etc. */}
        </div>
      )}
    </div>
  </div>
);
```

**Concretely:** preserve the original outer `<div>`'s **children** verbatim under the `else` branch, but put them inside a sibling `<div>` to the `<Sidebar/>`. Keep all existing event handlers, refs, and conditional renders inside that branch unchanged.

If the existing `App.tsx` has overlays/modals (Settings, Tooltip, Changelog, MigrationNotice) rendered as siblings to the canvas, keep them inside the same right-pane `<div>` so they don't accidentally render under the sidebar.

- [ ] **Step 13.4: Build, type-check, and lint**

```bash
cd webview-ui && npm run build && cd ..
```

Expected: clean build. If TS complains about `React.JSX.Element` not being a value (some setups use `JSX.Element`), change the component return types accordingly — pixel-agents' tsconfig should accept both.

- [ ] **Step 13.5: Commit**

```bash
git add webview-ui/src/App.tsx
git commit -m "$(cat <<'EOF'
Wrap App.tsx in a 2-column layout: Sidebar | (Welcome | Office)

When the project list is empty, the right pane shows the Welcome
splash; otherwise the existing pixel-art office (canvas + toolbar
+ modals) renders unchanged. The Sidebar is always present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Smoke test

**Files:** none modified.

- [ ] **Step 14.1: Cleanup before launch**

```bash
cd /Users/rubenperez/Sites/localhost/deepthix-agent
lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1 && echo "PORT BUSY — kill prior dev first" || echo "PORT FREE"
```

- [ ] **Step 14.2: Launch dev**

```bash
mkdir -p /tmp/deepthix-smoke
nohup npm run dev > /tmp/deepthix-smoke/p1-dev.log 2>&1 &
echo $! > /tmp/deepthix-smoke/p1-dev.pid
disown
```

Wait until either Vite + Cargo finish:

```bash
until grep -q "Finished\|error\|panicked\|FAILED" /tmp/deepthix-smoke/p1-dev.log 2>/dev/null; do sleep 2; done
tail -40 /tmp/deepthix-smoke/p1-dev.log
```

- [ ] **Step 14.3: Verify boot logs**

```bash
LATEST=$(ls -t ~/.deepthix/logs/*.log | head -1)
echo "Log file: $LATEST"
tail -30 "$LATEST"
```

Expect lines from `deepthix::boot` and (after the user opens a folder, which the smoke test cannot do automatically) `deepthix::commands` for `add_project`, etc.

- [ ] **Step 14.4: Manual UI verification (this is what the user does)**

In the open Tauri window:

1. The Welcome splash should be visible (large "Open Folder" button).
2. Click "Open Folder" → native macOS folder picker.
3. Pick any folder (e.g., `~/Documents` or `/Users/rubenperez/Sites/localhost/deepthix-agent` itself).
4. The Welcome screen should disappear; the sidebar should now show the project at the top and its file tree at the bottom.
5. Open a directory in the file tree by clicking it — children should lazy-load.
6. Click "+ Open Folder" again, pick a different folder, confirm both projects appear and clicking switches between them.
7. The active project's `●` marker should move; the file tree should refresh to the active project's contents.
8. Click the × next to a project to remove it. Confirm it disappears.
9. Quit (⌘Q). Reopen via `npm run dev` (after killing the old one). Confirm projects persisted.
10. Inspect `~/.deepthix/projects.json` — should contain valid JSON with the projects you added.

Capture findings.

- [ ] **Step 14.5: Cleanup**

```bash
PID=$(cat /tmp/deepthix-smoke/p1-dev.pid)
kill $PID 2>/dev/null
sleep 2
pkill -f "tauri dev" 2>/dev/null
pkill -f "vite" 2>/dev/null
pkill -f "target/debug/app" 2>/dev/null
sleep 1
lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1 && echo "STILL BUSY" || echo "PORT FREE"
```

---

## Task 15: Tag, merge, update master plan

- [ ] **Step 15.1: Tag**

```bash
cd /Users/rubenperez/Sites/localhost/deepthix-agent
git tag deepthix-phase-1-done
```

- [ ] **Step 15.2: Merge to main**

```bash
git checkout main
git merge --no-ff phase-1/projects-sidebar -m "$(cat <<'EOF'
Merge Phase 1 — Projects + Sidebar

Outcome: Open Folder works; sidebar shows project list + active
project's file tree; switching projects works and persists across
restarts via ~/.deepthix/projects.json.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 15.3: Update master plan**

Open `/Users/rubenperez/Sites/localhost/deepthix-agent/docs/superpowers/plans/2026-04-24-deepthix-master-plan.md` and replace Phase 1's `TBD` plan link with the actual filename:

```markdown
| 1 | Projects + sidebar | [`2026-04-24-deepthix-phase-1-projects-sidebar.md`](./2026-04-24-deepthix-phase-1-projects-sidebar.md) | Open Folder works. Sidebar shows project list + active project file tree. Can switch projects. State persisted to `~/.deepthix/projects.json`. |
```

```bash
git add docs/superpowers/plans/2026-04-24-deepthix-master-plan.md
git commit -m "$(cat <<'EOF'
Update master plan: Phase 1 plan filename

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 1 — Definition of Done

- [ ] `git log --oneline` shows commits for tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13.
- [ ] `git tag --list` shows `deepthix-phase-1-done`.
- [ ] `cd src-tauri && cargo test` — all tests pass (storage, state, commands::fs).
- [ ] `cd webview-ui && npm test` — all tests pass.
- [ ] `cd webview-ui && npm run build` — clean build.
- [ ] `cd src-tauri && cargo build` — clean build.
- [ ] `npm run dev` opens a Tauri window showing the Welcome splash on first launch.
- [ ] After "Open Folder", the sidebar lists the project and shows its file tree.
- [ ] After quitting and relaunching, the project list and active project are restored from `~/.deepthix/projects.json`.
- [ ] `~/.deepthix/projects.json` exists, contains valid JSON with `projects: []` and `active_project_id: string | null`.
- [ ] Switching projects updates the file tree.
- [ ] Removing a project removes it from the sidebar and from the JSON file.

When all the above are checked, Phase 1 is done. Invoke `superpowers:writing-plans` to author Phase 2 (Pixel office wired — bring the existing pixel-art canvas alive with assets loaded via Tauri commands and per-project layout persistence).
