# Deepthix Agent — Phase 2: Pixel Office Wired

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pixel-art office canvas renders properly inside Tauri (sprites, floors, walls, furniture, default layout), and any layout edits the user makes persist per-project to `~/.deepthix/projects/<hash>/layout.json`.

**Architecture:** Pixel-agents already has a fully working `browserMock` (`webview-ui/src/browserMock.ts`) that fetches assets from Vite dev middleware (or decodes PNGs at runtime) and dispatches the standard `characterSpritesLoaded` / `floorTilesLoaded` / `wallTilesLoaded` / `furnitureAssetsLoaded` / `layoutLoaded` / `settingsLoaded` messages. Tauri's webview loads from `http://localhost:1420/` in dev, so the same asset URLs work — we just need to enable the mock for the Tauri runtime too. For layout persistence, the existing webview emits a `saveLayout` postMessage when the user commits an edit — we intercept that in `tauriApi.ts` and route to a new Rust command. On `project_switched`, Rust loads the new project's layout and emits a `layoutLoaded` event back to the webview.

**Tech Stack:** No new deps. Reuses `browserMock`, the Tauri command/event infrastructure from Phase 1, and the same per-project storage location convention from the spec.

**Spec:** [`../specs/2026-04-24-deepthix-agent-design.md`](../specs/2026-04-24-deepthix-agent-design.md) — sections "Storage > ~/.deepthix/projects/<hash>/layout.json" and "Architecture > Data flow".
**Master plan:** [`./2026-04-24-deepthix-master-plan.md`](./2026-04-24-deepthix-master-plan.md)
**Working dir:** `/Users/rubenperez/Sites/localhost/deepthix-agent`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/src/storage.rs` | Modify | Add `project_dir(project_id) -> PathBuf` helper that returns `~/.deepthix/projects/<id>/`. |
| `src-tauri/src/commands/layout.rs` | Create | Two commands: `save_layout(project_id, layout)`, `load_layout(project_id) -> Option<Layout>`. Layout passed as opaque `serde_json::Value` — Rust doesn't model the layout shape. |
| `src-tauri/src/commands/mod.rs` | Modify | Export `pub mod layout;` |
| `src-tauri/src/lib.rs` | Modify | Register the two new commands in `invoke_handler`; subscribe to `project_switched` (in setup) to push `layoutLoaded` to the webview. |
| `webview-ui/src/tauri/commands.ts` | Modify | Add `saveLayout(projectId, layout)` and `loadLayout(projectId)` wrappers. |
| `webview-ui/src/tauri/events.ts` | Modify | Add `onLayoutLoaded(handler)` listener (mirrors the existing webview `layoutLoaded` postMessage). |
| `webview-ui/src/tauriApi.ts` | Modify | Intercept `postMessage({type: 'saveLayout', layout})` and route to `commands.saveLayout(activeProjectId, layout)`. |
| `webview-ui/src/App.tsx` | Modify | Enable `dispatchMockMessages()` for Tauri runtime too (the gate becomes `isBrowserRuntime || isTauriRuntime`). On `project_switched` event (already in useProjects), call `loadLayout(activeId)` and re-dispatch `layoutLoaded` to the webview. |

**Why we keep using browserMock instead of moving asset loading to Rust:** the existing Vite middleware already decodes PNGs once and serves them as compact JSON; the webview consumes them. Doing the same work in Rust would duplicate effort with zero behavior gain. Production-bundle asset loading (when `tauri build` is used instead of `tauri dev`) is deferred to Phase 9.

---

## Pre-flight

- [ ] **Step P1: Confirm Phase 1 baseline**
```bash
cd /Users/rubenperez/Sites/localhost/deepthix-agent
git checkout main
git tag --list deepthix-phase-1-done
git log --oneline -3
```
Expected: tag exists, recent commit `Merge Phase 1 — Projects + Sidebar`.

- [ ] **Step P2: Branch**
```bash
git checkout -b phase-2/pixel-office
```

- [ ] **Step P3: Confirm baseline builds**
```bash
(cd src-tauri && cargo build) && (cd webview-ui && npm run build)
```

---

## Task 1: Storage helper for per-project dirs

**Files:** Modify `src-tauri/src/storage.rs` to add a `project_dir(id)` helper.

- [ ] **Step 1.1: Add helper at the bottom of storage.rs (above `#[cfg(test)]`)**

Append to `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/storage.rs` (after `deepthix_dir()` definition):

```rust
/// Returns `~/.deepthix/projects/<id>/`, creating it if absent.
pub fn project_dir(id: &str) -> std::io::Result<PathBuf> {
    let dir = deepthix_dir()?.join("projects").join(id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
```

- [ ] **Step 1.2: Add a test in the `#[cfg(test)]` block**

Add to the existing `mod tests` block:

```rust
    #[test]
    fn project_dir_is_created_under_deepthix_projects() {
        let dir = project_dir("abc123").unwrap();
        assert!(dir.ends_with("projects/abc123"), "got {:?}", dir);
        assert!(dir.is_dir());
    }
```

- [ ] **Step 1.3: Run + commit**
```bash
cd src-tauri && cargo test --lib storage:: 2>&1 | tail -5 && cd ..
git add src-tauri/src/storage.rs
git commit -m "Add storage::project_dir() helper for per-project state

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
Expected: 6 storage tests pass.

---

## Task 2: Layout commands (save/load)

**Files:** Create `src-tauri/src/commands/layout.rs`; modify `src-tauri/src/commands/mod.rs`.

- [ ] **Step 2.1: Create the layout commands**

Create `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/commands/layout.rs`:

```rust
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
```

- [ ] **Step 2.2: Update `commands/mod.rs`**

Add to `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/commands/mod.rs`:
```rust
pub mod fs;
pub mod layout;
pub mod projects;
```

- [ ] **Step 2.3: Run + commit**
```bash
cd src-tauri && cargo test --lib commands::layout:: 2>&1 | tail -5 && cd ..
git add src-tauri/src/commands/layout.rs src-tauri/src/commands/mod.rs
git commit -m "Add save_layout/load_layout commands (per-project JSON)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
Expected: 2 layout tests pass.

---

## Task 3: Wire layout commands in lib.rs

**Files:** Modify `src-tauri/src/lib.rs`.

- [ ] **Step 3.1: Add the two commands to the invoke handler**

In `/Users/rubenperez/Sites/localhost/deepthix-agent/src-tauri/src/lib.rs`, find the `.invoke_handler(tauri::generate_handler![...])` block. Add `commands::layout::save_layout` and `commands::layout::load_layout` to the list. The block becomes:

```rust
        .invoke_handler(tauri::generate_handler![
            commands::projects::open_folder,
            commands::projects::add_project,
            commands::projects::list_projects,
            commands::projects::switch_project,
            commands::projects::remove_project,
            commands::fs::list_dir,
            commands::layout::save_layout,
            commands::layout::load_layout,
        ])
```

- [ ] **Step 3.2: Build + commit**
```bash
cd src-tauri && cargo build 2>&1 | tail -3 && cd ..
git add src-tauri/src/lib.rs
git commit -m "Register save_layout / load_layout in invoke_handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: TS wrappers for layout commands + event

**Files:** Modify `webview-ui/src/tauri/commands.ts` and `webview-ui/src/tauri/events.ts`.

- [ ] **Step 4.1: Add wrappers in commands.ts**

Append to `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/tauri/commands.ts`:

```ts
export async function saveLayout(projectId: string, layout: unknown): Promise<void> {
  log('saveLayout', { projectId });
  return await invoke<void>('save_layout', { projectId, layout });
}

export async function loadLayout(projectId: string): Promise<unknown | null> {
  log('loadLayout', { projectId });
  return await invoke<unknown | null>('load_layout', { projectId });
}
```

- [ ] **Step 4.2: Update commands.test.ts**

Add to the test in `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/test/commands.test.ts`:
```ts
  assert.equal(typeof mod.saveLayout, 'function');
  assert.equal(typeof mod.loadLayout, 'function');
```

- [ ] **Step 4.3: Build + test + commit**
```bash
cd webview-ui && npm run build && npm test 2>&1 | tail -5 && cd ..
git add webview-ui/src/tauri/commands.ts webview-ui/test/commands.test.ts
git commit -m "Add saveLayout / loadLayout TS wrappers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Intercept saveLayout postMessage in tauriApi.ts

The webview's existing `useExtensionMessages` and editor logic emit `vscode.postMessage({ type: 'saveLayout', layout })` when the user saves a layout edit. In Tauri runtime, that should reach our Rust command instead of being a no-op.

**Files:** Modify `webview-ui/src/tauriApi.ts`.

- [ ] **Step 5.1: Replace the file**

Overwrite `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/tauriApi.ts` with:

```ts
/**
 * Tauri IPC bridge for the webview's `vscode.postMessage` calls.
 *
 * The webview was authored against the VS Code extension protocol. To avoid
 * touching every call site, we accept the same `postMessage({ type, ... })`
 * shape and route known message types to the corresponding Tauri command.
 *
 * Unknown types are logged and ignored. New routes land here as new phases
 * wire more behaviors through the bridge.
 */
import * as commands from './tauri/commands';

interface MessageBridge {
  postMessage(msg: unknown): void;
}

/**
 * The active project id used as the scope for layout saves. Set externally
 * (App.tsx subscribes to project changes and calls setActiveProjectId).
 * If null, saveLayout is dropped with a warning.
 */
let activeProjectId: string | null = null;

export function setActiveProjectId(id: string | null): void {
  activeProjectId = id;
}

interface SaveLayoutMsg {
  type: 'saveLayout';
  layout: unknown;
}

function isSaveLayoutMsg(msg: unknown): msg is SaveLayoutMsg {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'saveLayout'
  );
}

export const tauri: MessageBridge = {
  postMessage(msg: unknown): void {
    if (isSaveLayoutMsg(msg)) {
      if (activeProjectId === null) {
        console.warn('[Deepthix][bridge] saveLayout dropped — no active project');
        return;
      }
      void commands.saveLayout(activeProjectId, msg.layout).catch((err) => {
        console.error('[Deepthix][bridge] saveLayout failed', err);
      });
      return;
    }
    // Future phases will route more message types (saveAgentSeats, settings, etc.)
    console.debug('[Deepthix][bridge] unrouted postMessage', msg);
  },
};
```

- [ ] **Step 5.2: Build + commit**
```bash
cd webview-ui && npm run build 2>&1 | tail -5 && cd ..
git add webview-ui/src/tauriApi.ts
git commit -m "Route saveLayout postMessage through Tauri command

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Layout-loaded event listener + project switch hook in App.tsx

**Files:** Modify `webview-ui/src/tauri/events.ts`, `webview-ui/src/App.tsx`.

- [ ] **Step 6.1: Add event listener in events.ts**

Append to `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/tauri/events.ts`:

```ts
/**
 * Re-dispatches a saved layout into the webview's existing message protocol
 * so the office canvas re-renders without changes to the consumer code.
 */
export function dispatchLayoutLoaded(layout: unknown): void {
  console.debug('[Deepthix][evt] dispatch layoutLoaded', !!layout);
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'layoutLoaded', layout } }),
  );
}
```

- [ ] **Step 6.2: Update App.tsx — enable mock in Tauri + bridge active project + load layout on switch**

In `/Users/rubenperez/Sites/localhost/deepthix-agent/webview-ui/src/App.tsx`, change the imports near the top to add:

```ts
import { isBrowserRuntime, isTauriRuntime } from './runtime';
import { setActiveProjectId } from './tauriApi';
import { loadLayout } from './tauri/commands';
import { dispatchLayoutLoaded } from './tauri/events';
```

(Remove the existing single-line `import { isBrowserRuntime } from './runtime';` if present — replace it with the multi-symbol import. If `runtime` is already imported, just merge.)

Find the existing `useEffect` block:
```ts
  useEffect(() => {
    if (isBrowserRuntime) {
      void import('./browserMock.js').then(({ dispatchMockMessages }) => dispatchMockMessages());
    }
  }, []);
```

Replace with:
```ts
  // Bootstrap mock messages (assets + default layout) in both browser and
  // Tauri dev runtimes. The browser mock fetches assets from the Vite dev
  // middleware; Tauri's webview hits the same dev server in dev mode.
  useEffect(() => {
    if (isBrowserRuntime || isTauriRuntime) {
      void import('./browserMock.js').then(({ dispatchMockMessages }) => dispatchMockMessages());
    }
  }, []);

  // Keep the tauri postMessage bridge informed of the active project so it
  // knows the scope for `saveLayout` calls coming from the webview.
  useEffect(() => {
    setActiveProjectId(projects.activeProjectId);
  }, [projects.activeProjectId]);

  // When the active project changes, load its persisted layout (if any)
  // and re-dispatch `layoutLoaded` to the webview so the office swaps in.
  useEffect(() => {
    if (!isTauriRuntime) return;
    const id = projects.activeProjectId;
    if (!id) return;
    let cancelled = false;
    void loadLayout(id).then((layout) => {
      if (cancelled) return;
      if (layout) dispatchLayoutLoaded(layout);
    }).catch((err) => {
      console.error('[Deepthix][App] loadLayout failed', err);
    });
    return () => {
      cancelled = true;
    };
  }, [projects.activeProjectId]);
```

- [ ] **Step 6.3: Build + commit**
```bash
cd webview-ui && npm run build 2>&1 | tail -5 && cd ..
git add webview-ui/src/tauri/events.ts webview-ui/src/App.tsx
git commit -m "Enable mock dispatch in Tauri + load per-project layout on switch

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Smoke test + tag + merge

- [ ] **Step 7.1: Launch and verify**
```bash
cd /Users/rubenperez/Sites/localhost/deepthix-agent
mkdir -p /tmp/deepthix-smoke
nohup npm run dev > /tmp/deepthix-smoke/p2-dev.log 2>&1 &
echo $! > /tmp/deepthix-smoke/p2-dev.pid; disown
until grep -q "tauri setup complete\|error\|panicked" /tmp/deepthix-smoke/p2-dev.log 2>/dev/null; do sleep 2; done
tail -25 /tmp/deepthix-smoke/p2-dev.log
```

Expected: clean boot. The user manually verifies in the Tauri window:
1. Open a folder.
2. The pixel-art office should now render WITH sprites (characters, floor tiles, walls, furniture) — no longer blank.
3. Click "Layout" toolbar button (in BottomToolbar) to enter edit mode. Paint a tile or place furniture. Click Save.
4. Quit the app, relaunch (`npm run dev` again), reopen the same project. The custom layout should be restored.
5. Open a SECOND project; its office should be the default layout (not the first project's edits). Switch back to the first; first project's edits return.

- [ ] **Step 7.2: Cleanup, tag, merge**
```bash
PID=$(cat /tmp/deepthix-smoke/p2-dev.pid); kill $PID 2>/dev/null
sleep 2
pkill -f "tauri dev|vite|target/debug/app" 2>/dev/null
sleep 1
git tag deepthix-phase-2-done
git checkout main
git merge --no-ff phase-2/pixel-office -m "Merge Phase 2 — Pixel office wired

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7.3: Update master plan**

In `/Users/rubenperez/Sites/localhost/deepthix-agent/docs/superpowers/plans/2026-04-24-deepthix-master-plan.md`, replace Phase 2's row to mark done with the plan filename and `deepthix-phase-2-done` tag.

```bash
git add docs/superpowers/plans/2026-04-24-deepthix-master-plan.md
git commit -m "Update master plan: Phase 2 marked done

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Definition of Done

- [ ] `git tag --list` shows `deepthix-phase-2-done`.
- [ ] `cargo test --lib` — all storage + layout + projects + fs tests pass (8 storage incl. project_dir, 2 layout, etc.).
- [ ] `webview-ui` build succeeds.
- [ ] Pixel office renders in Tauri window (non-blank).
- [ ] Saved layout persists at `~/.deepthix/projects/<id>/layout.json`.
- [ ] Switching projects restores each project's saved layout.

When done, invoke writing-plans for Phase 3 (Terminals: pty + xterm + bottom panel).
