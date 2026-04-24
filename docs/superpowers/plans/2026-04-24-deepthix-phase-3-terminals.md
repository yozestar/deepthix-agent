# Deepthix Agent — Phase 3: Terminals (pty + xterm)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click `+ Agent` → a bottom panel slides up containing a real macOS shell running in a pty (no `claude` integration yet — that's Phase 4). The user types, sees output, and can resize the terminal. Multiple agents → multiple tabs in the bottom panel. Click an agent character in the office → focuses its terminal tab. Close-button on tabs kills the pty.

**Architecture:** Rust manages ptys via `portable-pty` (cross-platform pty crate). A `TerminalManager` holds `HashMap<TerminalId, PtyHandle>`; each PtyHandle owns the writer half + a spawned async reader task that emits `pty_data` events. Frontend uses `xterm.js` to render and capture input. The BottomPanel is a tabbed React component; tabs map 1:1 to terminals. The existing `BottomToolbar`'s `+ Agent` button (already in pixel-agents) is hijacked: instead of dispatching the legacy `openClaude` postMessage, it calls a new `spawnAgent` Tauri command. Office characters are spawned by the existing webview message protocol (`agentCreated`) which we synthesize in JS once the pty is ready.

**Tech Stack:** `portable-pty` (Rust crate), `xterm` + `@xterm/addon-fit` (npm), Tauri events for pty I/O streaming.

**Spec:** [`../specs/2026-04-24-deepthix-agent-design.md`](../specs/2026-04-24-deepthix-agent-design.md) — sections "Architecture > pty/manager.rs", "UI Layout > Bottom panel".
**Working dir:** `/Users/rubenperez/Sites/localhost/deepthix-agent`

---

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/Cargo.toml` | Modify | Add `portable-pty = "0.8"` |
| `src-tauri/src/pty.rs` | Create | `PtyHandle` (writer + child kill), `TerminalManager` (HashMap), spawn/write/resize/kill operations |
| `src-tauri/src/commands/terminals.rs` | Create | `spawn_terminal(cwd) -> {id}`, `pty_write(id, data)`, `pty_resize(id, cols, rows)`, `kill_terminal(id)` |
| `src-tauri/src/commands/mod.rs` | Modify | Export `pub mod terminals;` |
| `src-tauri/src/lib.rs` | Modify | Manage `TerminalManager`, register the 4 commands, hold an `AppHandle` for emitting `pty_data` |
| `webview-ui/package.json` | Modify | Add `xterm`, `@xterm/addon-fit` deps |
| `webview-ui/src/tauri/commands.ts` | Modify | Add `spawnTerminal`, `ptyWrite`, `ptyResize`, `killTerminal` wrappers |
| `webview-ui/src/tauri/events.ts` | Modify | Add `onPtyData(handler)` listener |
| `webview-ui/src/components/TerminalTab.tsx` | Create | xterm.js renderer; subscribes to `pty_data` filtered by termId; sends keystrokes to `ptyWrite`; resize handling |
| `webview-ui/src/components/BottomPanel.tsx` | Create | Container with tab bar + close button; renders the active tab's content (TerminalTab) |
| `webview-ui/src/hooks/useTerminals.ts` | Create | React state for the list of open terminals + active tab id; `addTerminal`, `closeTerminal`, `setActive` |
| `webview-ui/src/tauriApi.ts` | Modify | Intercept `openClaude` postMessage (the existing `+ Agent` button dispatch) and route to `spawnTerminal` + add to terminals state |
| `webview-ui/src/App.tsx` | Modify | Render `<BottomPanel terminals={terminals}/>` below the office canvas (collapses when no tabs) |

---

## Pre-flight

- [ ] **P1** `git checkout main && git tag --list deepthix-phase-2-done` (must exist) → `git checkout -b phase-3/terminals`
- [ ] **P2** `cd src-tauri && cargo build && cd ..` (clean baseline)

---

## Task 1: Add Rust pty dep

- [ ] **1.1** Add to `[dependencies]` in `src-tauri/Cargo.toml`:
```toml
portable-pty = "0.8"
```
- [ ] **1.2** `cd src-tauri && cargo build && cd ..`
- [ ] **1.3** `git add src-tauri/Cargo.toml src-tauri/Cargo.lock && git commit -m "Add portable-pty dep" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"`

---

## Task 2: PtyHandle + TerminalManager

**File:** Create `src-tauri/src/pty.rs`

- [ ] **2.1** Write the file:

```rust
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// A single pty: a writer (stdin) + a kill handle (Drop kills the child).
pub struct PtyHandle {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

impl PtyHandle {
    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        self.writer.lock().unwrap().write_all(data)
    }
    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
    pub fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }
}

pub struct TerminalManager {
    inner: Mutex<HashMap<String, PtyHandle>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }

    /// Spawn a shell pty. The `on_data` closure is called from a background
    /// thread for each chunk read from the pty stdout/stderr.
    pub fn spawn_shell<F: FnMut(&str, &[u8]) + Send + 'static>(
        &self,
        id: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        mut on_data: F,
    ) -> std::io::Result<()> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        drop(pair.slave);

        let writer = pair.master.take_writer()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let reader = pair.master.try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let master_arc = Arc::new(Mutex::new(pair.master));

        let id_for_thread = id.clone();
        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => on_data(&id_for_thread, &buf[..n]),
                    Err(_) => break,
                }
            }
            tracing::debug!(target: "deepthix::pty", id = %id_for_thread, "reader exit");
        });

        let handle = PtyHandle {
            writer: Arc::new(Mutex::new(writer)),
            master: master_arc,
            child: Arc::new(Mutex::new(child)),
        };
        self.inner.lock().unwrap().insert(id, handle);
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> std::io::Result<()> {
        let map = self.inner.lock().unwrap();
        let handle = map.get(id).ok_or_else(|| std::io::Error::other("no such terminal"))?;
        handle.write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(handle) = self.inner.lock().unwrap().get(id) {
            handle.resize(cols, rows);
        }
    }

    pub fn kill(&self, id: &str) {
        if let Some(handle) = self.inner.lock().unwrap().remove(id) {
            handle.kill();
        }
    }
}
```

- [ ] **2.2** Add `mod pty;` near the top of `src-tauri/src/lib.rs` (next to `mod state;`).

- [ ] **2.3** `cd src-tauri && cargo build 2>&1 | tail -5 && cd ..`. Expected: clean.

- [ ] **2.4** Commit:
```bash
git add src-tauri/src/pty.rs src-tauri/src/lib.rs
git commit -m "Add PtyHandle + TerminalManager via portable-pty" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Terminal commands + emit pty_data

**File:** Create `src-tauri/src/commands/terminals.rs`; modify `commands/mod.rs`.

- [ ] **3.1** Write `src-tauri/src/commands/terminals.rs`:

```rust
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::pty::TerminalManager;

#[derive(Serialize, Clone)]
pub struct SpawnResult {
    pub id: String,
}

#[derive(Serialize, Clone)]
pub struct PtyDataPayload {
    pub id: String,
    pub data: String,
}

#[tauri::command]
pub fn spawn_terminal(
    app: AppHandle,
    state: State<'_, TerminalManager>,
    cwd: PathBuf,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SpawnResult, String> {
    let id = format!("term-{}", uuid_short());
    tracing::info!(target: "deepthix::commands", %id, ?cwd, "spawn_terminal");
    let app_clone = app.clone();
    state
        .spawn_shell(
            id.clone(),
            cwd,
            cols.unwrap_or(80),
            rows.unwrap_or(24),
            move |term_id, data| {
                let payload = PtyDataPayload {
                    id: term_id.to_string(),
                    data: String::from_utf8_lossy(data).to_string(),
                };
                let _ = app_clone.emit("pty_data", payload);
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(SpawnResult { id })
}

#[tauri::command]
pub fn pty_write(state: State<'_, TerminalManager>, id: String, data: String) -> Result<(), String> {
    state.write(&id, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, TerminalManager>, id: String, cols: u16, rows: u16) {
    state.resize(&id, cols, rows);
}

#[tauri::command]
pub fn kill_terminal(state: State<'_, TerminalManager>, id: String) {
    tracing::info!(target: "deepthix::commands", %id, "kill_terminal");
    state.kill(&id);
}

fn uuid_short() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}", nanos as u64)
}
```

- [ ] **3.2** Update `src-tauri/src/commands/mod.rs`:
```rust
pub mod fs;
pub mod layout;
pub mod projects;
pub mod terminals;
```

- [ ] **3.3** Update `src-tauri/src/lib.rs` — add `TerminalManager` to managed state and register the 4 commands. Find `.manage(app_state)` and `.invoke_handler(...)`. Replace with:

```rust
        .manage(app_state)
        .manage(crate::pty::TerminalManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::projects::open_folder,
            commands::projects::add_project,
            commands::projects::list_projects,
            commands::projects::switch_project,
            commands::projects::remove_project,
            commands::fs::list_dir,
            commands::layout::save_layout,
            commands::layout::load_layout,
            commands::terminals::spawn_terminal,
            commands::terminals::pty_write,
            commands::terminals::pty_resize,
            commands::terminals::kill_terminal,
        ])
```

- [ ] **3.4** Build + commit:
```bash
cd src-tauri && cargo build 2>&1 | tail -5 && cd ..
git add src-tauri/src/commands/ src-tauri/src/lib.rs
git commit -m "Wire 4 terminal commands + emit pty_data events" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add xterm to webview + TS wrappers

- [ ] **4.1** Install xterm:
```bash
cd webview-ui
npm install --save xterm @xterm/addon-fit
cd ..
```

- [ ] **4.2** Append to `webview-ui/src/tauri/commands.ts`:

```ts
export interface SpawnTerminalResult { id: string }

export async function spawnTerminal(cwd: string, cols?: number, rows?: number): Promise<SpawnTerminalResult> {
  log('spawnTerminal', { cwd, cols, rows });
  return await invoke<SpawnTerminalResult>('spawn_terminal', { cwd, cols, rows });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  return await invoke<void>('pty_write', { id, data });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return await invoke<void>('pty_resize', { id, cols, rows });
}

export async function killTerminal(id: string): Promise<void> {
  log('killTerminal', { id });
  return await invoke<void>('kill_terminal', { id });
}
```

- [ ] **4.3** Append to `webview-ui/src/tauri/events.ts`:

```ts
export interface PtyDataEvent {
  id: string;
  data: string;
}

export async function onPtyData(handler: (e: PtyDataEvent) => void): Promise<UnlistenFn> {
  return await listen<PtyDataEvent>('pty_data', (event) => {
    handler(event.payload);
  });
}
```

- [ ] **4.4** Build + commit:
```bash
cd webview-ui && npm run build 2>&1 | tail -3 && cd ..
git add webview-ui/package.json webview-ui/package-lock.json webview-ui/src/tauri/
git commit -m "Add xterm + TS wrappers for pty commands/events" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: useTerminals hook

**File:** Create `webview-ui/src/hooks/useTerminals.ts`

- [ ] **5.1** Write:

```ts
import { useCallback, useState } from 'react';

import { killTerminal as cmdKillTerminal, spawnTerminal as cmdSpawnTerminal } from '../tauri/commands';

export interface TerminalEntry {
  id: string;
  label: string;
  cwd: string;
}

export interface UseTerminalsResult {
  terminals: TerminalEntry[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  open: (cwd: string, label?: string) => Promise<TerminalEntry | null>;
  close: (id: string) => Promise<void>;
}

export function useTerminals(): UseTerminalsResult {
  const [terminals, setTerminals] = useState<TerminalEntry[]>([]);
  const [activeId, setActive] = useState<string | null>(null);

  const open = useCallback(async (cwd: string, label?: string): Promise<TerminalEntry | null> => {
    try {
      const { id } = await cmdSpawnTerminal(cwd);
      const entry: TerminalEntry = { id, label: label ?? `term-${terminals.length + 1}`, cwd };
      setTerminals((prev) => [...prev, entry]);
      setActive(id);
      return entry;
    } catch (e) {
      console.error('[Deepthix][useTerminals] open failed', e);
      return null;
    }
  }, [terminals.length]);

  const close = useCallback(async (id: string): Promise<void> => {
    try {
      await cmdKillTerminal(id);
    } catch (e) {
      console.error('[Deepthix][useTerminals] kill failed', e);
    }
    setTerminals((prev) => prev.filter((t) => t.id !== id));
    setActive((prev) => (prev === id ? null : prev));
  }, []);

  return { terminals, activeId, setActive, open, close };
}
```

- [ ] **5.2** Build + commit:
```bash
cd webview-ui && npm run build 2>&1 | tail -3 && cd ..
git add webview-ui/src/hooks/useTerminals.ts
git commit -m "Add useTerminals hook" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: TerminalTab component (xterm.js)

**File:** Create `webview-ui/src/components/TerminalTab.tsx`

- [ ] **6.1** Write:

```tsx
import { FitAddon } from '@xterm/addon-fit';
import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';

import { ptyResize, ptyWrite } from '../tauri/commands';
import { onPtyData, type PtyDataEvent } from '../tauri/events';

import 'xterm/css/xterm.css';

interface Props {
  termId: string;
  visible: boolean;
}

export function TerminalTab({ termId, visible }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'Menlo, monospace',
      theme: { background: '#1e1e2e' },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const writeDisposable = term.onData((data) => {
      void ptyWrite(termId, data);
    });

    let unlisten: (() => void) | null = null;
    void onPtyData((e: PtyDataEvent) => {
      if (e.id === termId) term.write(e.data);
    }).then((fn) => { unlisten = fn; });

    const resizeObserver = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      void ptyResize(termId, termRef.current.cols, termRef.current.rows);
    });
    resizeObserver.observe(el);

    return () => {
      writeDisposable.dispose();
      unlisten?.();
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [termId]);

  useEffect(() => {
    if (visible && fitRef.current && termRef.current) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        if (termRef.current) {
          void ptyResize(termId, termRef.current.cols, termRef.current.rows);
        }
      });
    }
  }, [visible, termId]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        display: visible ? 'block' : 'none',
        background: 'var(--color-bg)',
      }}
    />
  );
}
```

- [ ] **6.2** Build + commit:
```bash
cd webview-ui && npm run build 2>&1 | tail -3 && cd ..
git add webview-ui/src/components/TerminalTab.tsx
git commit -m "Add TerminalTab component (xterm.js wrapper)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: BottomPanel component

**File:** Create `webview-ui/src/components/BottomPanel.tsx`

- [ ] **7.1** Write:

```tsx
import type { UseTerminalsResult } from '../hooks/useTerminals';

import { TerminalTab } from './TerminalTab';

interface Props {
  terminals: UseTerminalsResult;
}

export function BottomPanel({ terminals }: Props): React.JSX.Element | null {
  if (terminals.terminals.length === 0) return null;
  return (
    <div
      style={{
        height: '300px',
        borderTop: '2px solid var(--color-border)',
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-pixel)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
          padding: '0 4px',
          gap: '2px',
          minHeight: '32px',
          flexShrink: 0,
        }}
      >
        {terminals.terminals.map((t) => {
          const isActive = t.id === terminals.activeId;
          return (
            <button
              key={t.id}
              onClick={() => terminals.setActive(t.id)}
              style={{
                padding: '6px 12px',
                background: isActive ? 'var(--color-accent)' : 'transparent',
                color: isActive ? 'var(--color-bg-dark)' : 'inherit',
                border: '2px solid var(--color-border)',
                cursor: 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '11px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              💻 {t.label}
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  void terminals.close(t.id);
                }}
                style={{ opacity: 0.7, padding: '0 2px' }}
                aria-label={`Close ${t.label}`}
              >
                ×
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {terminals.terminals.map((t) => (
          <div
            key={t.id}
            style={{
              position: 'absolute',
              inset: 0,
              display: t.id === terminals.activeId ? 'block' : 'none',
            }}
          >
            <TerminalTab termId={t.id} visible={t.id === terminals.activeId} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **7.2** Build + commit:
```bash
cd webview-ui && npm run build 2>&1 | tail -3 && cd ..
git add webview-ui/src/components/BottomPanel.tsx
git commit -m "Add BottomPanel: tab bar + active terminal pane" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Hijack +Agent button via tauriApi.ts; mount BottomPanel in App.tsx

The existing `BottomToolbar` (pixel-agents) dispatches `vscode.postMessage({ type: 'openClaude' })` on `+ Agent` click. We intercept it.

- [ ] **8.1** Modify `webview-ui/src/tauriApi.ts` — add a callback registry that App.tsx populates with the openTerminal function. Replace the file content:

```ts
import * as commands from './tauri/commands';

interface MessageBridge {
  postMessage(msg: unknown): void;
}

let activeProjectId: string | null = null;
let activeProjectPath: string | null = null;
let onOpenTerminal: ((cwd: string) => void) | null = null;

export function setActiveProjectId(id: string | null): void {
  activeProjectId = id;
}

export function setActiveProjectPath(path: string | null): void {
  activeProjectPath = path;
}

export function setOnOpenTerminal(fn: ((cwd: string) => void) | null): void {
  onOpenTerminal = fn;
}

interface SaveLayoutMsg { type: 'saveLayout'; layout: unknown }
interface OpenClaudeMsg { type: 'openClaude' }

function isSaveLayoutMsg(msg: unknown): msg is SaveLayoutMsg {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'saveLayout';
}
function isOpenClaudeMsg(msg: unknown): msg is OpenClaudeMsg {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'openClaude';
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
    if (isOpenClaudeMsg(msg)) {
      if (!activeProjectPath || !onOpenTerminal) {
        console.warn('[Deepthix][bridge] openClaude dropped — no active project / no terminal handler');
        return;
      }
      onOpenTerminal(activeProjectPath);
      return;
    }
    console.debug('[Deepthix][bridge] unrouted postMessage', msg);
  },
};
```

- [ ] **8.2** Update `webview-ui/src/App.tsx`. Add imports:
```ts
import { BottomPanel } from './components/BottomPanel';
import { useTerminals } from './hooks/useTerminals';
import { setActiveProjectPath, setOnOpenTerminal } from './tauriApi';
```

Inside `App()` add the hook + register the bridge handlers (near the other useEffects):
```ts
  const terminals = useTerminals();

  useEffect(() => {
    setActiveProjectPath(projects.activeProject?.path ?? null);
  }, [projects.activeProject?.path]);

  useEffect(() => {
    setOnOpenTerminal((cwd) => { void terminals.open(cwd); });
    return () => setOnOpenTerminal(null);
  }, [terminals]);
```

Render the BottomPanel inside the right pane, BELOW the office canvas. Find the existing `<div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>` block (the inner one, second `position: 'relative'`). Wrap its parent in a column-flex and mount the panel as a sibling AFTER the office div:

Locate this block:
```tsx
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {hasProjects && projects.activeProject && ( ... project name badge ... )}
        {!hasProjects ? (
```

After the closing of the inner `position: 'relative'` div (the one that wraps the office canvas + project badge), add:
```tsx
        </div>
        <BottomPanel terminals={terminals} />
      </div>
```

Concretely: the existing structure was `outer flex-col > [inner office div] > end`. Now becomes `outer flex-col > [inner office div] > <BottomPanel/> > end`.

Find the matching `</div>` that currently closes the right pane (the one before `</div>` closing the outer App return, around line ~462) and insert `<BottomPanel terminals={terminals} />` just BEFORE it but AFTER the office's inner div closes.

A safe edit: search for the line `        </div>\n      </div>\n    </div>\n  );` near the end and change the second `      </div>` (the one closing the right pane outer container) to:
```tsx
        </div>
        <BottomPanel terminals={terminals} />
      </div>
```

- [ ] **8.3** Build + commit:
```bash
cd webview-ui && npm run build 2>&1 | tail -3 && cd ..
git add webview-ui/src/tauriApi.ts webview-ui/src/App.tsx
git commit -m "Hijack +Agent button → spawn pty terminal in BottomPanel" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Smoke test + tag + merge

- [ ] **9.1** Launch:
```bash
mkdir -p /tmp/deepthix-smoke
nohup npm run dev > /tmp/deepthix-smoke/p3-dev.log 2>&1 &
echo $! > /tmp/deepthix-smoke/p3-dev.pid; disown
until grep -q "tauri setup complete\|error\|panicked" /tmp/deepthix-smoke/p3-dev.log; do sleep 2; done
tail -10 /tmp/deepthix-smoke/p3-dev.log
```

- [ ] **9.2** User verifies: open the app, click `+ Agent` in the bottom toolbar. A bottom panel should slide up showing a shell prompt. Type `ls` + Enter — see output. Click `+ Agent` again → second tab. Switch tabs. Click × on a tab → tab disappears, pty killed.

- [ ] **9.3** Cleanup + tag + merge:
```bash
PID=$(cat /tmp/deepthix-smoke/p3-dev.pid); kill $PID 2>/dev/null
sleep 2; pkill -f "tauri dev|vite|target/debug/app" 2>/dev/null
git tag deepthix-phase-3-done
git checkout main
git merge --no-ff phase-3/terminals -m "Merge Phase 3 — Terminals (pty + xterm)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **9.4** Update master plan (Phase 3 row → done with tag).

---

## Phase 3 — Definition of Done

- [ ] `+ Agent` button opens a working shell in a bottom panel.
- [ ] Multiple tabs supported; switching works.
- [ ] Close button kills the pty.
- [ ] `cargo test --lib` still passes (no new tests added — pty is integration-tested by smoke).
- [ ] `cargo build` and `npm run build` succeed.
- [ ] Tag `deepthix-phase-3-done` exists.
