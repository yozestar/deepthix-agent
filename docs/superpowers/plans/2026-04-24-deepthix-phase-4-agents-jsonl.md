# Deepthix Agent — Phase 4: Agents + JSONL Watcher

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `+ Agent` no longer spawns a bare zsh — it spawns `claude --session-id <uuid>` in the active project's cwd. Rust watches the corresponding `~/.claude/projects/<hash>/<uuid>.jsonl` transcript and forwards each new record to the webview, which parses tool_use/tool_result and animates the office character. Heuristic mode only (hooks land in Phase 5). Sub-agents and timer logic deferred to a polish phase.

**Architecture:** Add a "kind" parameter to `spawn_terminal` (`'shell' | 'claude'`). When kind is `claude`, generate a UUID, build the cmd as `claude --session-id <uuid>`, and start a polling JSONL watcher in Rust on the predicted file path (computed from project cwd). The watcher reads new lines (with partial-line buffering for atomic-write safety) and emits `agent_jsonl_line` events. The webview has a small TS parser (~80 lines) that converts records to the existing pixel-agents message protocol (`agentCreated`, `agentToolStart`, `agentToolDone`, `agentStatus`) — those events already animate the canvas character.

**Tech Stack:** `notify` crate for file change events, plus 500ms poll fallback (per pixel-agents condensed lessons: `fs.watch` unreliable on macOS). UUID generation via `uuid` crate.

**Spec:** [`../specs/2026-04-24-deepthix-agent-design.md`](../specs/2026-04-24-deepthix-agent-design.md) — sections "Agent Status Tracking", "JSONL polling".
**Working dir:** `/Users/rubenperez/Sites/localhost/deepthix-agent`

---

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/Cargo.toml` | Modify | Add `uuid = { version = "1", features = ["v4"] }`, `notify = "7"` |
| `src-tauri/src/jsonl_watcher.rs` | Create | `JsonlWatcher`: polls a file every 500ms with offset tracking + partial-line buffering. Emits parsed lines via callback |
| `src-tauri/src/commands/terminals.rs` | Modify | `spawn_terminal` accepts `kind` (default `shell`). When `claude`: generate uuid, build cmd `claude --session-id <uuid>`, start a JsonlWatcher for `~/.claude/projects/<hash>/<uuid>.jsonl`, emit `agent_jsonl_line` per line |
| `src-tauri/src/lib.rs` | Modify | (no changes if pty.rs / commands stay; just the existing wiring works) |
| `webview-ui/src/transcriptParser.ts` | Create | Parses one JSONL record string → 0..n webview messages (`agentCreated`, `agentToolStart`, `agentToolDone`, `agentStatus`). Subset of pixel-agents extension parser. |
| `webview-ui/src/tauri/commands.ts` | Modify | `spawnTerminal` accepts `kind: 'shell' \| 'claude'` |
| `webview-ui/src/tauri/events.ts` | Modify | `onAgentJsonlLine(handler)` |
| `webview-ui/src/hooks/useTerminals.ts` | Modify | `open()` accepts kind; default `'shell'`. Add `openAgent(cwd)` convenience. Subscribe to `onAgentJsonlLine` and dispatch parser output as window message events. |
| `webview-ui/src/tauriApi.ts` | Modify | `openClaude` postMessage now routes to `openAgent` (kind: claude), not generic shell |

---

## Pre-flight

- [ ] **P1** `git checkout main && git tag --list deepthix-phase-3-done && git checkout -b phase-4/agents-jsonl`
- [ ] **P2** `cd src-tauri && cargo build && cd ..`
- [ ] **P3** Verify `claude` is in PATH: `which claude` (must print a path; if not, the user needs to install Claude Code CLI: `npm install -g @anthropic-ai/claude-code`)

---

## Task 1: Deps

- [ ] **1.1** Add to `[dependencies]` in `src-tauri/Cargo.toml`:
```toml
uuid = { version = "1", features = ["v4"] }
notify = "7"
```
- [ ] **1.2** `cd src-tauri && cargo build && cd .. && git add src-tauri/Cargo.* && git commit -m "Add uuid + notify deps for agent JSONL watching" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"`

---

## Task 2: JsonlWatcher (polling)

**File:** Create `src-tauri/src/jsonl_watcher.rs`

- [ ] **2.1** Write:

```rust
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const POLL_INTERVAL_MS: u64 = 500;

/// Polls a JSONL file on disk and invokes `on_line` for every newly-appended
/// line. Handles partial-line buffering for files mid-write. Stops when the
/// returned StopHandle is dropped.
pub struct JsonlWatcher {
    stop: Arc<Mutex<bool>>,
}

impl JsonlWatcher {
    pub fn start<F: FnMut(&str) + Send + 'static>(
        path: PathBuf,
        mut on_line: F,
    ) -> Self {
        let stop = Arc::new(Mutex::new(false));
        let stop_ref = Arc::clone(&stop);
        thread::spawn(move || {
            let mut offset: u64 = 0;
            let mut buffer = String::new();
            tracing::debug!(target: "deepthix::jsonl", ?path, "watcher started");
            loop {
                if *stop_ref.lock().unwrap() {
                    tracing::debug!(target: "deepthix::jsonl", ?path, "watcher stopped");
                    return;
                }
                if let Ok(mut file) = File::open(&path) {
                    let _ = file.seek(SeekFrom::Start(offset));
                    let mut reader = BufReader::new(&mut file);
                    let mut chunk = String::new();
                    loop {
                        chunk.clear();
                        match reader.read_line(&mut chunk) {
                            Ok(0) => break,
                            Ok(_n) => {
                                buffer.push_str(&chunk);
                                offset += chunk.len() as u64;
                                if buffer.ends_with('\n') {
                                    for line in buffer.lines() {
                                        if !line.is_empty() {
                                            on_line(line);
                                        }
                                    }
                                    buffer.clear();
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            }
        });
        Self { stop }
    }
}

impl Drop for JsonlWatcher {
    fn drop(&mut self) {
        *self.stop.lock().unwrap() = true;
    }
}

/// Computes the JSONL path Claude Code would write for this project + session.
/// Mirrors pixel-agents convention: `~/.claude/projects/<hash>/<uuid>.jsonl`
/// where `hash` = absolute project path with `/`, `\`, `:` replaced by `-`.
pub fn predict_jsonl_path(project_cwd: &std::path::Path, session_id: &str) -> PathBuf {
    let raw = project_cwd.to_string_lossy();
    let hash: String = raw.chars().map(|c| match c {
        '/' | '\\' | ':' => '-',
        other => other,
    }).collect();
    dirs::home_dir().unwrap_or_default()
        .join(".claude").join("projects").join(hash).join(format!("{session_id}.jsonl"))
}
```

- [ ] **2.2** Add `mod jsonl_watcher;` to `src-tauri/src/lib.rs` near other `mod` declarations.

- [ ] **2.3** Add a unit test in `jsonl_watcher.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::mpsc::channel;
    use tempfile::tempdir;

    #[test]
    fn watcher_emits_lines_as_they_arrive() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.jsonl");
        std::fs::write(&path, b"").unwrap();
        let (tx, rx) = channel::<String>();
        let _watcher = JsonlWatcher::start(path.clone(), move |line| {
            let _ = tx.send(line.to_string());
        });
        std::thread::sleep(Duration::from_millis(700));
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{{\"type\":\"hello\"}}").unwrap();
        let received = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(received.contains("hello"));
    }

    #[test]
    fn predict_jsonl_path_replaces_slashes() {
        let p = predict_jsonl_path(std::path::Path::new("/Users/x/foo"), "abc-123");
        let s = p.to_string_lossy();
        assert!(s.ends_with("-Users-x-foo/abc-123.jsonl"), "got {}", s);
    }
}
```

- [ ] **2.4** `cd src-tauri && cargo test --lib jsonl_watcher:: 2>&1 | tail -5 && cd .. && git add src-tauri/src/jsonl_watcher.rs src-tauri/src/lib.rs && git commit -m "Add JsonlWatcher (500ms polling, partial-line buffering)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"`. Expected: 2 jsonl tests pass.

---

## Task 3: Extend spawn_terminal with kind=claude

**File:** Modify `src-tauri/src/commands/terminals.rs`

- [ ] **3.1** Replace the file with:

```rust
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::jsonl_watcher::{predict_jsonl_path, JsonlWatcher};
use crate::pty::TerminalManager;

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "lowercase")]
pub enum TerminalKind {
    #[default]
    Shell,
    Claude,
}

#[derive(Serialize, Clone)]
pub struct SpawnResult {
    pub id: String,
    pub session_id: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PtyDataPayload {
    pub id: String,
    pub data: String,
}

#[derive(Serialize, Clone)]
pub struct AgentJsonlPayload {
    pub id: String,
    pub session_id: String,
    pub line: String,
}

/// Holds JsonlWatchers keyed by terminal id so they live as long as the agent.
#[derive(Default)]
pub struct WatcherRegistry {
    inner: Mutex<std::collections::HashMap<String, Arc<JsonlWatcher>>>,
}

impl WatcherRegistry {
    pub fn insert(&self, id: String, watcher: JsonlWatcher) {
        self.inner.lock().unwrap().insert(id, Arc::new(watcher));
    }
    pub fn remove(&self, id: &str) {
        self.inner.lock().unwrap().remove(id);
    }
}

#[tauri::command]
pub fn spawn_terminal(
    app: AppHandle,
    pty: State<'_, TerminalManager>,
    watchers: State<'_, WatcherRegistry>,
    cwd: PathBuf,
    cols: Option<u16>,
    rows: Option<u16>,
    kind: Option<TerminalKind>,
) -> Result<SpawnResult, String> {
    let kind = kind.unwrap_or_default();
    let id = format!("term-{}", Uuid::new_v4().simple());
    tracing::info!(target: "deepthix::commands", %id, ?cwd, ?serialize_kind(&kind), "spawn_terminal");
    let app_data = app.clone();
    pty
        .spawn_with_kind(
            id.clone(),
            cwd.clone(),
            cols.unwrap_or(80),
            rows.unwrap_or(24),
            &kind,
            move |term_id, data| {
                let payload = PtyDataPayload {
                    id: term_id.to_string(),
                    data: String::from_utf8_lossy(data).to_string(),
                };
                let _ = app_data.emit("pty_data", payload);
            },
        )
        .map_err(|e| e.to_string())?;
    let session_id = match kind {
        TerminalKind::Claude => {
            let session_id = pty.get_session_id(&id).unwrap_or_default();
            let jsonl = predict_jsonl_path(&cwd, &session_id);
            tracing::info!(target: "deepthix::commands", %id, %session_id, ?jsonl, "watching jsonl");
            let app_for_watcher = app.clone();
            let id_for_watcher = id.clone();
            let session_for_watcher = session_id.clone();
            let watcher = JsonlWatcher::start(jsonl, move |line| {
                let _ = app_for_watcher.emit("agent_jsonl_line", AgentJsonlPayload {
                    id: id_for_watcher.clone(),
                    session_id: session_for_watcher.clone(),
                    line: line.to_string(),
                });
            });
            watchers.insert(id.clone(), watcher);
            Some(session_id)
        }
        TerminalKind::Shell => None,
    };
    Ok(SpawnResult { id, session_id })
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
pub fn kill_terminal(
    pty: State<'_, TerminalManager>,
    watchers: State<'_, WatcherRegistry>,
    id: String,
) {
    tracing::info!(target: "deepthix::commands", %id, "kill_terminal");
    pty.kill(&id);
    watchers.remove(&id);
}

fn serialize_kind(k: &TerminalKind) -> &'static str {
    match k { TerminalKind::Shell => "shell", TerminalKind::Claude => "claude" }
}
```

- [ ] **3.2** The above references `pty.spawn_with_kind` and `pty.get_session_id` — extend `src-tauri/src/pty.rs` to add these. Modify `pty.rs`:

Add at the top of `impl TerminalManager` (before the existing `spawn_shell`):
```rust
    pub fn spawn_with_kind<F: FnMut(&str, &[u8]) + Send + 'static>(
        &self,
        id: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        kind: &crate::commands::terminals::TerminalKind,
        on_data: F,
    ) -> std::io::Result<()> {
        match kind {
            crate::commands::terminals::TerminalKind::Shell => self.spawn_shell(id, cwd, cols, rows, on_data),
            crate::commands::terminals::TerminalKind::Claude => self.spawn_claude(id, cwd, cols, rows, on_data),
        }
    }

    fn spawn_claude<F: FnMut(&str, &[u8]) + Send + 'static>(
        &self,
        id: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        mut on_data: F,
    ) -> std::io::Result<()> {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;

        let session_id = uuid::Uuid::new_v4().to_string();
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let mut cmd = CommandBuilder::new("claude");
        cmd.arg("--session-id");
        cmd.arg(&session_id);
        cmd.cwd(cwd);
        for (k, v) in std::env::vars() { cmd.env(k, v); }

        let child = pair.slave.spawn_command(cmd)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        drop(pair.slave);

        let writer = pair.master.take_writer()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let reader = pair.master.try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let master_arc = std::sync::Arc::new(std::sync::Mutex::new(pair.master));

        let id_for_thread = id.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => on_data(&id_for_thread, &buf[..n]),
                    Err(_) => break,
                }
            }
            tracing::debug!(target: "deepthix::pty", id = %id_for_thread, "claude reader exit");
        });

        let handle = PtyHandle {
            writer: std::sync::Arc::new(std::sync::Mutex::new(writer)),
            master: master_arc,
            child: std::sync::Arc::new(std::sync::Mutex::new(child)),
            session_id: Some(session_id),
        };
        self.inner.lock().unwrap().insert(id, handle);
        Ok(())
    }

    pub fn get_session_id(&self, id: &str) -> Option<String> {
        self.inner.lock().unwrap().get(id).and_then(|h| h.session_id.clone())
    }
```

And add `session_id: Option<String>` field to the existing `PtyHandle` struct. The existing `spawn_shell` should set this to `None` when constructing PtyHandle.

- [ ] **3.3** Update `src-tauri/src/lib.rs` `.manage(...)` calls to include the WatcherRegistry:
```rust
        .manage(crate::pty::TerminalManager::new())
        .manage(crate::commands::terminals::WatcherRegistry::default())
```

- [ ] **3.4** `cd src-tauri && cargo build 2>&1 | tail -5 && cd .. && git add src-tauri/src/ && git commit -m "Add claude pty kind + JSONL watcher wiring" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"`

---

## Task 4: TS wrappers + parser + hooks

- [ ] **4.1** Update `webview-ui/src/tauri/commands.ts` — replace `spawnTerminal` to accept kind:

```ts
export type TerminalKind = 'shell' | 'claude';

export interface SpawnTerminalResult { id: string; session_id: string | null }

export async function spawnTerminal(
  cwd: string,
  kind: TerminalKind = 'shell',
  cols?: number,
  rows?: number,
): Promise<SpawnTerminalResult> {
  log('spawnTerminal', { cwd, kind, cols, rows });
  return await invoke<SpawnTerminalResult>('spawn_terminal', { cwd, cols, rows, kind });
}
```

- [ ] **4.2** Append to `webview-ui/src/tauri/events.ts`:

```ts
export interface AgentJsonlEvent { id: string; session_id: string; line: string }

export async function onAgentJsonlLine(handler: (e: AgentJsonlEvent) => void): Promise<UnlistenFn> {
  return await listen<AgentJsonlEvent>('agent_jsonl_line', (event) => handler(event.payload));
}
```

- [ ] **4.3** Create `webview-ui/src/transcriptParser.ts`:

```ts
/**
 * Subset of pixel-agents transcript parser. Reads one JSONL record
 * (already-parsed JSON) and returns 0..n window-message-event payloads
 * for the office canvas to consume.
 *
 * Records of interest:
 *  - `assistant` with content[].type === 'tool_use' → agentToolStart
 *  - `user` with content[].type === 'tool_result' → agentToolDone
 *  - `system` with subtype === 'turn_duration' → agentToolClear (turn end)
 */

interface AssistantToolUseBlock { type: 'tool_use'; id: string; name: string; input?: unknown }
interface UserToolResultBlock { type: 'tool_result'; tool_use_id: string }
interface AssistantRecord { type: 'assistant'; message?: { content: AssistantToolUseBlock[] } }
interface UserRecord { type: 'user'; message?: { content: UserToolResultBlock[] | string } }
interface SystemRecord { type: 'system'; subtype: string }

type Record = AssistantRecord | UserRecord | SystemRecord | { type: string };

export interface WebviewMessage { type: string; [key: string]: unknown }

export function parseRecord(agentId: number, raw: string): WebviewMessage[] {
  let record: Record;
  try { record = JSON.parse(raw) as Record; } catch { return []; }
  const out: WebviewMessage[] = [];
  if (record.type === 'assistant') {
    const r = record as AssistantRecord;
    const blocks = r.message?.content ?? [];
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        out.push({ type: 'agentToolStart', agentId, toolId: block.id, toolName: block.name });
      }
    }
  } else if (record.type === 'user') {
    const r = record as UserRecord;
    if (Array.isArray(r.message?.content)) {
      for (const block of r.message!.content) {
        if (block.type === 'tool_result') {
          out.push({ type: 'agentToolDone', agentId, toolId: block.tool_use_id });
        }
      }
    }
  } else if (record.type === 'system') {
    const r = record as SystemRecord;
    if (r.subtype === 'turn_duration') {
      out.push({ type: 'agentToolClear', agentId });
    }
  }
  return out;
}
```

- [ ] **4.4** Modify `webview-ui/src/hooks/useTerminals.ts` — add `kind` parameter and JSONL listener wiring:

Update `open` signature to `open(cwd: string, kind: TerminalKind = 'shell', label?: string)`. After `cmdSpawnTerminal` call, capture the agentId numeric counter and start the JSONL listener subscription if kind is claude.

Replace the file:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import { killTerminal as cmdKillTerminal, spawnTerminal as cmdSpawnTerminal, type TerminalKind } from '../tauri/commands';
import { onAgentJsonlLine } from '../tauri/events';
import { parseRecord } from '../transcriptParser';

export interface TerminalEntry {
  id: string;
  label: string;
  cwd: string;
  kind: TerminalKind;
  agentId: number;
  sessionId: string | null;
}

export interface UseTerminalsResult {
  terminals: TerminalEntry[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  open: (cwd: string, kind?: TerminalKind, label?: string) => Promise<TerminalEntry | null>;
  close: (id: string) => Promise<void>;
}

export function useTerminals(): UseTerminalsResult {
  const [terminals, setTerminals] = useState<TerminalEntry[]>([]);
  const [activeId, setActive] = useState<string | null>(null);
  const nextAgentIdRef = useRef(1);

  // Single global listener for all agent jsonl lines; parses + dispatches as
  // window messages so the existing officeState consumes them via useExtensionMessages.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const idMap: Map<string, number> = new Map();
    const idSync = () => {
      idMap.clear();
      for (const t of terminalsRef.current) idMap.set(t.id, t.agentId);
    };
    const lookup = (termId: string): number | undefined => {
      if (!idMap.has(termId)) idSync();
      return idMap.get(termId);
    };
    void onAgentJsonlLine((e) => {
      const agentId = lookup(e.id);
      if (agentId === undefined) return;
      for (const msg of parseRecord(agentId, e.line)) {
        window.dispatchEvent(new MessageEvent('message', { data: msg }));
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Keep a ref to terminals for the listener closure to read fresh state.
  const terminalsRef = useRef<TerminalEntry[]>([]);
  useEffect(() => { terminalsRef.current = terminals; }, [terminals]);

  const open = useCallback(async (cwd: string, kind: TerminalKind = 'shell', label?: string): Promise<TerminalEntry | null> => {
    try {
      const result = await cmdSpawnTerminal(cwd, kind);
      const agentId = nextAgentIdRef.current++;
      const entry: TerminalEntry = {
        id: result.id,
        label: label ?? `${kind === 'claude' ? 'agent' : 'shell'}-${agentId}`,
        cwd, kind, agentId,
        sessionId: result.session_id,
      };
      setTerminals((prev) => [...prev, entry]);
      setActive(result.id);
      // Tell the office to spawn a character for this agent.
      if (kind === 'claude') {
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'agentCreated', id: agentId, terminalId: result.id, name: entry.label,
        }}));
      }
      return entry;
    } catch (e) {
      console.error('[Deepthix][useTerminals] open failed', e);
      return null;
    }
  }, []);

  const close = useCallback(async (id: string): Promise<void> => {
    const entry = terminalsRef.current.find((t) => t.id === id);
    try { await cmdKillTerminal(id); }
    catch (e) { console.error('[Deepthix][useTerminals] kill failed', e); }
    setTerminals((prev) => prev.filter((t) => t.id !== id));
    setActive((prev) => (prev === id ? null : prev));
    if (entry?.kind === 'claude') {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'agentClosed', id: entry.agentId,
      }}));
    }
  }, []);

  return { terminals, activeId, setActive, open, close };
}
```

- [ ] **4.5** Modify `webview-ui/src/tauriApi.ts` — change the `openClaude` route to spawn with kind=claude:

In the existing handler that has `if (isOpenClaudeMsg(msg))`, change the call to pass kind=claude. The current callback type accepts `(cwd: string)` — extend to `(cwd: string, kind: TerminalKind)` and update App.tsx accordingly.

Replace `setOnOpenTerminal` signature:
```ts
let onOpenTerminal: ((cwd: string, kind: 'shell' | 'claude') => void) | null = null;

export function setOnOpenTerminal(fn: ((cwd: string, kind: 'shell' | 'claude') => void) | null): void {
  onOpenTerminal = fn;
}
```

And the openClaude branch:
```ts
    if (isOpenClaudeMsg(msg)) {
      if (!activeProjectPath || !onOpenTerminal) {
        console.warn('[Deepthix][bridge] openClaude dropped — no active project / no terminal handler');
        return;
      }
      onOpenTerminal(activeProjectPath, 'claude');
      return;
    }
```

- [ ] **4.6** Update `webview-ui/src/App.tsx` — change the setOnOpenTerminal effect:

```ts
  useEffect(() => {
    setOnOpenTerminal((cwd, kind) => { void terminals.open(cwd, kind); });
    return () => setOnOpenTerminal(null);
  }, [terminals]);
```

- [ ] **4.7** Build, lint, commit:
```bash
cd webview-ui && npm run build 2>&1 | tail -3 && cd ..
npm run lint 2>&1 | tail -5
git add webview-ui/
git commit -m "Wire claude agent spawn + JSONL parser → office message events" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Smoke test + tag + merge

- [ ] **5.1** Launch + verify:
```bash
mkdir -p /tmp/deepthix-smoke
nohup npm run dev > /tmp/deepthix-smoke/p4-dev.log 2>&1 &
echo $! > /tmp/deepthix-smoke/p4-dev.pid; disown
until grep -q "tauri setup complete\|error\|panicked" /tmp/deepthix-smoke/p4-dev.log; do sleep 2; done
tail -10 /tmp/deepthix-smoke/p4-dev.log
```

User verifies: open the app, click `+ Agent`. The bottom panel opens; this time it runs `claude` (not zsh). A character should appear in the office (matrix spawn effect). Type a prompt to claude, hit Enter — when claude uses tools, the character should animate (typing/reading). Close the tab → character vanishes.

- [ ] **5.2** Cleanup, tag, merge, master plan update.

---

## Phase 4 — Definition of Done

- [ ] `+ Agent` spawns `claude` (verified by `ps -ef | grep claude` while running).
- [ ] `~/.claude/projects/<hash>/<uuid>.jsonl` is created (proves session id alignment).
- [ ] Office shows a new character per spawned agent.
- [ ] Character animates when claude uses tools (heuristic mode).
- [ ] Closing a terminal removes the character.
- [ ] Tag `deepthix-phase-4-done`.
