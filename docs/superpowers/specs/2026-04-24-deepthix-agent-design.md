# Deepthix Agent — Design Document

**Date:** 2026-04-24
**Status:** Draft, awaiting user review
**Author:** Ruben Perez (with Claude)

## Overview

Deepthix Agent is a standalone macOS desktop application built with **Tauri 2** that forks [Pixel Agents](https://github.com/pablodelucca/pixel-agents) (MIT, © pablodelucca) and re-houses it as a self-contained app instead of a VS Code/Cursor extension.

The goal: replace Cursor for the user's daily Claude Code workflow. Deepthix hosts Claude Code terminals natively, visualizes them as animated characters in a pixel art office, and adds a multi-project switcher, file tree, and read-only code viewer.

## Goals

- Standalone macOS desktop app — no VS Code or Cursor required.
- Source-available, fully modifiable by the user.
- Reuse the official Claude Code CLI as the agent backend (no API rewrite).
- Multi-project switching inside a single window.
- Pixel art office as the primary "home" view (Pixel Agents look & feel preserved).
- Read-only code viewing + project file tree.
- Comprehensive `[Deepthix]`-tagged logging across Rust, Node sidecar, and frontend, unified into a single rotating log file.

## Non-Goals (explicit YAGNI for v1)

- Code editing — viewer is **read-only** (Shiki). Editing is delegated to the agents.
- Code signing / notarization — local builds only. User runs `xattr -cr` if Gatekeeper complains.
- Cross-platform — **macOS only** for v1. (Linux/Windows possible later via Tauri.)
- Custom agent backend — no Anthropic SDK integration; CLI dependency is accepted.
- E2E testing — Playwright tests from pixel-agents are removed (they targeted VS Code).
- Multi-window — one window only. Multi-project switching happens inside that window via the left sidebar.
- Drag-agent-to-project reassignment — kept for future work.

## Stack

| Layer            | Tech                                                       |
| ---------------- | ---------------------------------------------------------- |
| Desktop runtime  | Tauri 2.x                                                  |
| Backend          | Rust (`portable-pty`, `notify`, `tracing`, `serde`)        |
| Frontend         | React 19 + TypeScript + Vite (forked from pixel-agents)    |
| Hook sidecar     | Node.js HTTP server (forked from pixel-agents `server/`)   |
| Terminal UI      | xterm.js                                                   |
| Code viewer      | Shiki (read-only syntax highlighting)                      |
| Local storage    | `~/.deepthix/` (JSON files)                                |
| Agent backend    | Claude Code CLI (`claude --session-id <uuid>`)             |

## Project Location

```
/Users/rubenperez/Sites/localhost/deepthix-agent/
```

Forked from `/Users/rubenperez/Sites/localhost/pixel-agents/`. Original `.git` removed; new repo initialized. License kept as MIT with attribution to pablodelucca preserved in `LICENSE` and `README.md`.

## Project Structure

```
deepthix-agent/
├── src-tauri/                       # NEW: Rust backend
│   ├── src/
│   │   ├── main.rs                  # entrypoint, init Tauri + tracing
│   │   ├── commands/
│   │   │   ├── projects.rs          # open_folder, list_projects, switch_project
│   │   │   ├── terminals.rs         # spawn_terminal, pty_write, pty_resize, kill
│   │   │   ├── fs.rs                # read_file, list_dir, watch_dir
│   │   │   └── server.rs            # start_hook_server (sidecar lifecycle)
│   │   ├── pty/
│   │   │   └── manager.rs           # TerminalManager: HashMap<id, PtyPair>
│   │   ├── watchers/
│   │   │   ├── jsonl.rs             # ~/.claude/projects/<hash>/*.jsonl polling
│   │   │   └── project.rs           # project file tree watcher (notify)
│   │   ├── state.rs                 # AppState: open projects, terminals
│   │   └── log.rs                   # tracing setup, file rotation
│   ├── Cargo.toml                   # tauri, portable-pty, notify, serde, tracing, tracing-appender
│   ├── tauri.conf.json              # bundle, sidecar (Node), permissions
│   ├── icons/                       # Mac .icns + PNG
│   └── build.rs
│
├── webview-ui/                      # FORKED, ~95% unchanged
│   ├── src/
│   │   ├── App.tsx                  # composition root (modified for new layout)
│   │   ├── hooks/
│   │   │   ├── useTauriEvents.ts    # NEW (replaces useExtensionMessages)
│   │   │   ├── useEditorActions.ts  # unchanged
│   │   │   ├── useEditorKeyboard.ts # unchanged
│   │   │   └── useProjects.ts       # NEW
│   │   ├── components/
│   │   │   ├── Sidebar.tsx          # NEW: ProjectList + FileTree
│   │   │   ├── ProjectList.tsx      # NEW
│   │   │   ├── FileTree.tsx         # NEW
│   │   │   ├── BottomPanel.tsx      # NEW: tabs container (terminals + viewer)
│   │   │   ├── TerminalTab.tsx      # NEW: xterm.js wrapper
│   │   │   ├── CodeViewer.tsx       # NEW: Shiki read-only
│   │   │   ├── BottomToolbar.tsx    # unchanged
│   │   │   ├── ZoomControls.tsx     # unchanged
│   │   │   ├── SettingsModal.tsx    # modified: add "Open Log File" button
│   │   │   ├── InfoModal.tsx        # unchanged
│   │   │   ├── Tooltip.tsx          # unchanged
│   │   │   └── DebugView.tsx        # unchanged
│   │   ├── office/                  # unchanged (renderer, sprites, characters, FSM, layout editor)
│   │   ├── tauri/                   # NEW: typed IPC wrappers
│   │   │   ├── commands.ts          # invoke() wrappers
│   │   │   └── events.ts            # listen() wrappers + types
│   │   ├── logger.ts                # NEW: [Deepthix] console wrapper, forwards to Rust
│   │   └── constants.ts             # unchanged
│   └── public/assets/               # unchanged (PNGs, manifests, default-layout.json)
│
├── server/                          # FORKED, runs as Tauri sidecar
│   ├── src/
│   │   ├── server.ts                # unchanged (HTTP server)
│   │   ├── hookEventHandler.ts      # unchanged
│   │   ├── constants.ts             # unchanged (timing/scanning constants)
│   │   └── providers/file/          # unchanged (hook installer + claude-hook script)
│   └── package.json                 # esbuild bundles to dist/server.js (CJS)
│
├── shared/                          # FORKED, types shared across layers
│
├── scripts/                         # FORKED, asset pipeline tools
│
├── docs/
│   └── superpowers/specs/           # this document lives here
│
├── package.json                     # root: dev/build/lint/test scripts
└── README.md                        # rewritten for Deepthix, attributes Pixel Agents
```

### Removed from pixel-agents

| Path                                   | Reason                                          |
| -------------------------------------- | ----------------------------------------------- |
| `src/extension.ts`                     | VS Code extension entrypoint                    |
| `src/PixelAgentsViewProvider.ts`       | VS Code WebviewViewProvider                     |
| `src/agentManager.ts`                  | replaced by `src-tauri/pty/manager.rs`          |
| `src/fileWatcher.ts`                   | replaced by `src-tauri/watchers/jsonl.rs`       |
| `src/transcriptParser.ts`              | port to Rust (or keep TS in webview)            |
| `src/timerManager.ts`                  | reproduced in webview                           |
| `src/configPersistence.ts`             | replaced by `src-tauri/commands/fs.rs`          |
| `src/layoutPersistence.ts`             | replaced by `src-tauri/commands/fs.rs`          |
| `src/assetLoader.ts`                   | port to Rust (PNG read backend-side)            |
| `e2e/`                                 | VS Code Playwright tests                        |
| `.vscode/`, `.vscodeignore`            | VS Code-specific                                |
| `esbuild.js`                           | bundled the extension; no longer needed         |
| `package.json` fields                  | `engines.vscode`, `activationEvents`, `main`, `contributes`, `@types/vscode`, `@vscode/test-electron` |

## UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Deepthix Agent — mon-app                  [+ Agent] [⚙️]    │  TopBar (40px)
├──────┬──────────────────────────────────────────────────────┤
│PROJ. │                                                      │
│      │                                                      │
│●mon-a│                                                      │
│ blog │           🏢  PIXEL ART OFFICE (HOME)                 │
│ exp  │              scoped to active project                │
│  +   │                                                      │
├──────┤                                                      │
│FILES │                                                      │
│      │                                                      │
│▸src  │                                                      │
│▸pub  │                                                      │
│ pkg  ├──────────────────────────────────────────────────────┤
│      │ [💻 agent-1] [💻 agent-2] [📄 Header.tsx]      [✕]   │  BottomPanel
│      │ ...                                                  │  (slide-up,
└──────┴──────────────────────────────────────────────────────┘  hidden by default)
```

### Behavior rules

1. **Pixel art office is the HOME view.** Always visible. Takes the entire main area when the bottom panel is closed. This mirrors Pixel Agents' UX — the office is the central abstraction, terminals and files are contextual.
2. **Left sidebar — two stacked sections (resizable divider):**
   - **PROJ.** (top): list of projects the user has opened. The active project is marked with `●`. Clicking a different project switches the entire UI to that project's state. `+` button opens a native macOS folder picker.
   - **FILES** (bottom): file tree for the active project only. Refreshed via the project file watcher. Standard exclusions: `node_modules/`, `.git/`, `dist/`, `target/`, `.deepthix/`.
3. **Bottom panel — slide-up, tabs:**
   - Hidden by default.
   - Opens automatically on:
     - Click on an agent character → opens/focuses that agent's terminal tab.
     - Click on a file in the file tree → opens/focuses the code viewer tab on that file.
   - Tabs: one per open terminal + one shared "Code Viewer" tab.
   - `✕` button closes the panel (returns to home).
4. **`+ Agent` button (top bar):** spawns a new pty running `claude --session-id <uuid>` in the active project's directory, creates a character, opens its terminal tab.
5. **Per-project state persistence.** Switching projects fully restores: office layout, agents (with seat/palette/hueShift), open terminals, scroll position in file tree, last-viewed file.

## Architecture

### Components and responsibilities

| Component                     | Responsibility                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `src-tauri/main.rs`           | Init Tauri, init `tracing` (stderr + file), spawn sidecar, register commands.  |
| `src-tauri/commands/*`        | IPC commands invoked by the React frontend.                                    |
| `src-tauri/pty/manager.rs`    | Owns `HashMap<TerminalId, PtyPair>`. Reads pty stdout, emits to frontend.      |
| `src-tauri/watchers/jsonl.rs` | 500ms-polling watcher for `~/.claude/projects/<hash>/<uuid>.jsonl`. Partial-line buffering. Emits parsed events. |
| `src-tauri/watchers/project.rs` | `notify` watcher for the active project's directory. Pushes file changes to frontend. |
| `src-tauri/state.rs`          | `AppState` (Mutex): open projects, terminal map, hook server handle.           |
| `server/` (sidecar)           | HTTP server listening on localhost; receives Claude Code hooks; writes `~/.deepthix/server.json` with port + token. |
| `webview-ui/`                 | React frontend rendering the office, sidebar, bottom panel, modals.            |

### IPC contract — Commands (React → Rust)

| Command                         | Payload                          | Returns                       |
| ------------------------------- | -------------------------------- | ----------------------------- |
| `open_folder()`                 | —                                | `Option<{path, id}>`          |
| `list_projects()`               | —                                | `Project[]`                   |
| `add_project(path)`             | `{path}`                         | `Project`                     |
| `switch_project(id)`            | `{id}`                           | `()`                          |
| `remove_project(id)`            | `{id}`                           | `()`                          |
| `spawn_agent(projectId, dangerouslySkipPermissions?)` | `{projectId, skip?}` | `{id, uuid, terminalId}`      |
| `kill_agent(id)`                | `{id}`                           | `()`                          |
| `pty_write(termId, data)`       | `{termId, data}`                 | `()`                          |
| `pty_resize(termId, cols, rows)` | `{termId, cols, rows}`          | `()`                          |
| `read_file(path)`               | `{path}`                         | `{contents, language}`        |
| `list_dir(path)`                | `{path}`                         | `FileEntry[]`                 |
| `save_layout(projectId, layout)` | `{projectId, layout}`           | `()`                          |
| `save_agent_seats(projectId, seats)` | `{projectId, seats}`        | `()`                          |
| `save_settings(settings)`       | `{settings}`                     | `()`                          |
| `export_layout(projectId)`      | `{projectId}`                    | `()` (opens save dialog)      |
| `import_layout(projectId)`      | `{projectId}`                    | `OfficeLayout`                |
| `add_external_asset_dir(path)`  | `{path}`                         | `()`                          |
| `remove_external_asset_dir(path)` | `{path}`                       | `()`                          |
| `open_log_file()`               | —                                | `()` (opens current log in Finder) |
| `log_from_frontend(level, msg)` | `{level, msg}`                   | `()`                          |

### IPC contract — Events (Rust → React)

Names mirror pixel-agents' webview message protocol where possible to minimize webview changes. New events flagged with **NEW**.

- Existing (semantics preserved): `agent_created`, `agent_closed`, `agent_status`, `agent_tool_start`, `agent_tool_done`, `agent_tool_clear`, `existing_agents`, `layout_loaded`, `furniture_assets_loaded`, `floor_tiles_loaded`, `wall_tiles_loaded`, `character_sprites_loaded`, `settings_loaded`, `external_asset_directories_updated`.
- **NEW**: `project_added`, `project_removed`, `project_switched`, `file_changed`, `pty_data` (stdout chunks), `pty_exit`.

### Data flow — spawning an agent

```
[+ Agent] click in webview
        │
        │ invoke('spawn_agent', { projectId })
        ▼
Rust: commands::terminals::spawn_agent
        │
        ├─ generate uuid
        ├─ portable-pty: spawn `claude --session-id <uuid>` in project cwd
        ├─ register in TerminalManager
        ├─ start async task: read pty stdout → emit('pty_data', {termId, data})
        ├─ start jsonl watcher for ~/.claude/projects/<hash>/<uuid>.jsonl
        │
        └─ return {id, uuid, terminalId}
                │
                ▼
        Webview: emit('agent_created', {...}) → office adds character
        Webview: subscribes to pty_data for this termId → xterm writes to terminal tab
```

### Data flow — agent activity

Two parallel sources feed the office animation, exactly as in pixel-agents:

1. **Hook server (preferred when active).** `~/.deepthix/hooks/claude-hook.js` is the script Claude Code invokes per hook event (SessionStart, PreToolUse, etc.). It POSTs to `localhost:<port>` (token-authenticated). The Node sidecar receives, classifies, and emits via Tauri's IPC bridge → webview animations update instantly. The `hookDelivered` flag per agent gates the JSONL-based heuristics.
2. **JSONL polling (always active).** Every 500ms the JSONL watcher reads new lines via offset tracking. Tool content (status text, animations) is always derived from JSONL. Only the *timer logic* (permission 7s, text-idle 5s) is suppressed when hooks have delivered for that agent. Partial-line buffering carries unterminated lines.

The Rust JSONL watcher mirrors `pixel-agents/src/transcriptParser.ts` semantics:
- `assistant.tool_use` → `agent_tool_start`
- `user.tool_result` → `agent_tool_done` (delayed 300ms)
- `system.subtype = "turn_duration"` → `agent_tool_clear`
- `progress.data.type` (`agent_progress`, `bash_progress`, `mcp_progress`) → relevant updates

### Hook installer

Identical to pixel-agents'. `server/src/providers/file/claudeHookInstaller.ts` writes hooks into `~/.claude/settings.json` pointing to `~/.deepthix/hooks/claude-hook.js`. Toggleable via Settings modal.

### Sidecar lifecycle

`tauri.conf.json > tauri.bundle.externalBin` declares the bundled Node binary + `server/dist/server.js`. On app start, Rust spawns it as a child process. Crash-restart loop in Rust (max 5 attempts in 60s, then surface error in UI). On app quit, the sidecar is killed cleanly.

## Storage

```
~/.deepthix/
├── config.json                # global: theme, sound, hooks_enabled, debug_view
├── projects.json              # [{id, path, name, last_opened, hue?}, ...]
├── server.json                # {port, pid, token} — written by sidecar
├── logs/
│   └── deepthix-YYYY-MM-DD.log   # rotated daily, all components unified
├── hooks/
│   └── claude-hook.js         # bundled hook script (CJS, esbuild output)
└── projects/
    └── <hash>/
        ├── layout.json        # OfficeLayout
        └── state.json         # {agents: [{id, uuid, palette, hueShift, seatId, terminalId}], lastViewedFile?, openTerminals: [...]}
```

`<hash>` = sha1 of the absolute project path (first 16 chars), so projects are addressed deterministically.

## Logging

**Goal:** debugging anywhere = `tail -f ~/.deepthix/logs/deepthix-<today>.log`.

### Rust (`src-tauri/`)

- `tracing` + `tracing-subscriber` + `tracing-appender` (daily rotation).
- Subscriber writes to **stderr** *and* to `~/.deepthix/logs/deepthix-YYYY-MM-DD.log`.
- All spans/events tagged with target `deepthix::<module>` (rendered as `[Deepthix][<module>]`).
- Default level `info`; `RUST_LOG=deepthix=debug` (or env var `DEEPTHIX_LOG`) enables debug.
- Logged: PTY spawn/exit, file watcher events, every IPC command (with payload truncated), every IPC event emitted, sidecar stdout/stderr forwarded.

### Frontend (webview)

- `webview-ui/src/logger.ts` exports `log.info/debug/warn/error(module, msg, data?)`.
- All logs prefixed with `[Deepthix][<module>]` in console + forwarded to Rust via `log_from_frontend` command, so they end up in the same file.
- Logged: every Tauri event received, every command invoked, asset loading errors, canvas/render errors, layout save errors.

### Sidecar (Node `server/`)

- `console.log` lines re-prefixed from `[Pixel Agents]` → `[Deepthix]`.
- Sidecar stdout/stderr captured by the Rust spawner and re-emitted via `tracing` so they land in the unified log.

### UI

- Settings modal includes:
  - Existing "Debug View" toggle (kept).
  - **NEW** "Open Log File" button — opens today's log in Finder (`Reveal in Finder`).
  - **NEW** "Log Level" dropdown (info/debug). Persisted in `config.json`. Restart required note.

## Tests

| Suite                                 | Tooling                  | Coverage                                                                       |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `webview-ui/` unit tests              | Vitest + Testing Library | Existing pixel-agents tests preserved. New tests for `useTauriEvents`, `Sidebar`, `BottomPanel`, `TerminalTab`, `CodeViewer`. |
| `server/` unit + integration tests    | Vitest                   | Existing pixel-agents tests preserved (server lifecycle, hook routing, hook installer, claude-hook integration). |
| `src-tauri/` unit + integration tests | `cargo test`             | `pty/manager.rs` (spawn/kill, write, output), `watchers/jsonl.rs` (line buffering, parsing, partial reads), commands (Tauri mock runtime). |
| E2E                                   | —                        | Removed (pixel-agents Playwright targeted VS Code).                            |

CI: not in scope for v1. Local `npm test && cargo test` is the bar.

## Build & Dev

### One-time setup

```bash
# Fork from pixel-agents
cp -r /Users/rubenperez/Sites/localhost/pixel-agents \
      /Users/rubenperez/Sites/localhost/deepthix-agent
cd /Users/rubenperez/Sites/localhost/deepthix-agent
rm -rf .git e2e src .vscode .vsixmanifest dist node_modules webview-ui/node_modules server/node_modules
git init

# Install
npm install                       # root tooling
cd webview-ui && npm install
cd ../server && npm install
cd ..

# Tauri CLI
cargo install tauri-cli --version "^2"

# Scaffold src-tauri/ (manual or via tauri-cli init)
cargo tauri init
```

### Dev

```bash
npm run dev
# = cargo tauri dev (auto-runs vite for webview, builds Rust, spawns sidecar)
```

### Production build (local Mac)

```bash
npm run build
# = cd server && npm run build (esbuild → dist/server.js)
# + cd webview-ui && npm run build (vite → dist)
# + cargo tauri build → src-tauri/target/release/bundle/macos/Deepthix Agent.app
```

No code signing / notarization. If macOS Gatekeeper blocks the unsigned `.app`:

```bash
xattr -cr "/Applications/Deepthix Agent.app"
```

### Root `package.json` scripts

```json
{
  "scripts": {
    "dev": "tauri dev",
    "build": "npm run build:server && npm run build:webview && tauri build",
    "build:webview": "cd webview-ui && npm run build",
    "build:server": "cd server && npm run build",
    "lint": "eslint webview-ui/src server/src && cargo clippy --manifest-path src-tauri/Cargo.toml",
    "test": "cd webview-ui && npm test && cd ../server && npm test && cargo test --manifest-path ../src-tauri/Cargo.toml"
  }
}
```

## Migration Steps (high-level)

1. Fork pixel-agents → `deepthix-agent/`, fresh git init.
2. Strip VS Code (delete `src/`, `e2e/`, `.vscode/`, `esbuild.js`, VS Code fields in `package.json`).
3. Scaffold `src-tauri/` via `cargo tauri init`.
4. Implement minimal Rust: app lifecycle + log setup + dummy commands.
5. Wire `webview-ui/` to render inside Tauri window (replace `vscode.postMessage` calls with Tauri IPC stubs that no-op).
6. Implement projects: `open_folder`, project list persistence, sidebar `ProjectList`, switch.
7. Implement file tree: `list_dir`, `notify` watcher, sidebar `FileTree`.
8. Implement bottom panel skeleton: `BottomPanel`, tabs.
9. Implement pty: `portable-pty` integration, `spawn_agent`, `pty_write/resize/data`, `TerminalTab` (xterm.js).
10. Implement JSONL watcher in Rust → emit existing pixel-agents events → office animations work.
11. Wire sidecar Node hook server, port discovery, hook installer.
12. Implement code viewer (Shiki), `read_file`, click-file → bottom panel.
13. Implement per-project state persistence (layout + agents + last-viewed file).
14. Logging unification (Rust + Node + frontend → single file).
15. Settings modal updates (Open Log File, Log Level).
16. Rebrand (icon, name, README, LICENSE attribution).
17. Manual smoke test on a real project.

## Open Questions / Future Work

- Migrate from CLI `claude` to direct **Claude Agent SDK** integration (would remove the external dependency).
- Multi-window (today: single window).
- Code editing (today: read-only).
- Linux / Windows builds (Tauri makes this nearly free, but not v1).
- Code signing + notarization for distribution.
- Drag-agent-to-project reassignment (the "desks as directories" vision from Pixel Agents).
- Replace JSONL polling entirely with hooks (today: hooks are an *override* on top of polling).
- Asset pipeline integration: `scripts/asset-manager.html` currently writes to repo paths; in a packaged app, asset edits should target an external asset directory under `~/.deepthix/`.

## Decisions Log

| Decision                                  | Rationale                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Tauri over Electron                       | Smaller bundle, native Mac feel, Rust backend gives full system control with no Node-in-the-app weight.  |
| Wrapper approach (vs full refactor)       | Minimum changes to webview = MVP in days, not weeks. We can refactor later.                              |
| Reuse Claude Code CLI                     | All hook + transcript machinery already exists, well-tested, and updates for free.                       |
| `xterm.js` + `portable-pty`               | Officially supported Tauri pattern, Rust-native.                                                         |
| Sidecar Node for hooks                    | The existing `server/` works as-is; rewriting in Rust is a non-goal.                                     |
| Multi-project in one window               | Matches user's stated workflow (switch projects via left sidebar).                                       |
| Read-only code viewer                     | YAGNI — agents do the editing. Avoids reimplementing Cursor.                                             |
| Local-only, unsigned                      | User builds for personal use only; no need for distribution infra.                                       |
| Per-project layout & state                | Lets the user have a customized office per project.                                                      |
| Unified `[Deepthix]` log file             | User explicitly asked for "log everywhere for easier debugging".                                         |
