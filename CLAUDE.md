# Deepthix Agent — Repository Reference

Standalone macOS desktop app for running and watching Claude Code sessions in a tamagotchi-style office. Forked from [pixel-agents](https://github.com/pablodelucca/pixel-agents) (MIT, by @pablodelucca); the upstream pixel office, asset pipeline, and JSONL parser are reused; the VS Code extension layer was stripped and replaced by a Tauri 2 shell.

## Architecture

```
src-tauri/      Rust shell (Tauri 2). Commands, pty manager, JSONL watcher, project storage.
webview-ui/     React + TypeScript + Vite frontend. Office canvas, terminals (xterm.js),
                file tree, file/memory panes, sidebar, mode tabs.
server/         Node hook server forked from pixel-agents. Currently UNUSED — kept as
                scaffolding for Phase 5 (Claude Code Hooks integration as Tauri sidecar).
shared/         Shared TS types (used by webview now; eventually by sidecar too).
eslint-rules/   Local ESLint plugin: no inline colors, pixel font, pixel shadows.
docs/           External-asset attribution and other public docs.
```

## Key components

- `src-tauri/src/lib.rs` — Tauri entry, command registration, app state.
- `src-tauri/src/pty.rs` — pty spawning + IO bridge (xterm-side data goes through Tauri events).
- `src-tauri/src/jsonl_watcher.rs` — watches `~/.claude/projects/*/*.jsonl` for active sessions.
- `src-tauri/src/storage.rs` — project list + per-project state in `~/.deepthix/`.
- `src-tauri/src/commands/` — Tauri command handlers (file I/O, project ops, terminal ops).
- `webview-ui/src/App.tsx` — composition root: sidebar + top tabs + main pane + bottom panel.
- `webview-ui/src/components/Sidebar.tsx` + `ProjectList.tsx` — project switcher.
- `webview-ui/src/components/TopTabs.tsx` — `SESSIONS` / `FILES` / `PROCESS` / `MEMORY` mode tabs.
- `webview-ui/src/components/TamagotchiView.tsx` + `Companion.tsx` + `PixelMonster.tsx` — rolling-balls visualization for active sessions; click-to-focus.
- `webview-ui/src/components/{FileTree,FilesPane,MemoryPane}.tsx` — file tree + viewer/editor + `CLAUDE.md` editor.
- `webview-ui/src/components/{BottomPanel,TerminalTab}.tsx` — slide-up bottom panel with xterm.js terminals.
- `webview-ui/src/hooks/useProjects.ts` / `useTerminals.ts` / `useFileTree.ts` / `useOpenFiles.ts` — Tauri command bindings.
- `webview-ui/src/tauri/{commands,events,types}.ts` — typed Tauri command and event surface.
- `webview-ui/src/office/` — pixel office engine (inherited from pixel-agents). FSM characters, BFS pathfinding, layout editor.
- `webview-ui/src/transcriptParser.ts` — JSONL transcript → tool/status events for the office.

## Build & dev commands

```bash
npm install                       # root deps
cd webview-ui && npm install      # webview deps (separate node_modules)
npm run dev                       # Tauri dev (Vite + cargo run)
npm run build                     # release .app
npm run lint                      # ESLint across server/shared/webview-ui
npm run test                      # webview + server (Vitest) + cargo test
cd src-tauri && cargo test        # Rust unit tests only
cd webview-ui && npm test         # Webview tests only
```

## Current state

**6 of 10 phases shipped.**

- Phases 0–4: shipped and tagged (`deepthix-phase-N-done`). Bootstrap, projects sidebar, pixel office, terminals (pty + xterm), agents + JSONL watcher.
- Phase 5 (Hook server sidecar): **deferred** — `server/` directory kept but not wired in. Heuristic JSONL polling does the work for now.
- Phase 6 (Code viewer with Shiki): **shipped** as part of the FILES tab (file viewer/editor with image preview). Shiki highlighting is the next iteration.
- Phase 7 (Per-project state persistence): **partially done** — projects, skipPermissions, sessions persist; layout/open-terminals/last-viewed-file persistence is incremental.
- Phase 8 (Unified logging): **partial** — Rust uses `tracing`; sidecar/frontend log unification is deferred.
- Phase 9 (Rebrand & polish): in progress (this commit).

## Coding constraints

- **No inline color literals** — use `--pixel-*` CSS custom properties (defined in `webview-ui/src/index.css`) or constants from `webview-ui/src/constants.ts`. Enforced by `deepthix/no-inline-colors`.
- **Pixel font everywhere** — `FS Pixel Sans` via `var(--font-pixel)`. Enforced by `deepthix/pixel-font`.
- **Pixel shadows** — hard offset `2px 2px 0px` or `var(--shadow-pixel)`. Enforced by `deepthix/pixel-shadow`.
- **No TypeScript `enum`** (`erasableSyntaxOnly`) — use `as const` objects.
- **`import type`** for type-only imports (`verbatimModuleSyntax`).
- All magic numbers / strings centralized in `*/constants.ts` files; CSS values in `:root`.

## Useful pointers

- Per-project state lives under `~/.deepthix/`.
- Claude session JSONL files: `~/.claude/projects/<project-hash>/<session-id>.jsonl` (project hash = workspace path with `:`/`\`/`/` → `-`).
- The office engine is documented in depth in the upstream pixel-agents `CHANGELOG.md` and source comments — refer to those for layout, asset, sprite, and rendering details.
