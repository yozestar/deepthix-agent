# Deepthix Agent

Standalone macOS desktop app for running and watching [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions in a tamagotchi-style office. Each project becomes a little world: agents are characters, sessions are rolling balls, and your `CLAUDE.md` lives one keystroke away.

This project is a fork of [pixel-agents](https://github.com/pablodelucca/pixel-agents) by [@pablodelucca](https://github.com/pablodelucca) (MIT). The original is a VS Code extension that visualizes Claude Code agents in a pixel art office; Deepthix Agent rebuilds that vision as a standalone Tauri desktop app with a project-centric workflow. Full credit to the original author for the pixel office, asset pipeline, and JSONL parsing primitives this app is built on.

## Status

Under active development. **6 of 10 phases shipped** — see [`docs/superpowers/plans/2026-04-24-deepthix-master-plan.md`](docs/superpowers/plans/2026-04-24-deepthix-master-plan.md) for the master plan and per-phase specs.

## Quick start

```bash
git clone <this-repo-url> deepthix-agent
cd deepthix-agent
npm install
cd webview-ui && npm install && cd ..
npm run dev
```

The `npm run dev` command launches Tauri in dev mode (it spawns Vite for the webview and `cargo run` for the Rust shell). First Rust build takes a few minutes; subsequent builds are incremental.

## Features (current)

- **Per-project sessions** — sidebar lists known projects; each project remembers its own `--dangerously-skip-permissions` preference and resumes its session list across launches.
- **Rolling-balls visualization** — active Claude sessions appear as little balls rolling around the office floor. Click a ball to focus the corresponding terminal/session.
- **4 mode tabs** — `SESSIONS` (the office view), `FILES` (project file tree + viewer/editor with image preview), `PROCESS` (live process state), `MEMORY` (`CLAUDE.md` editor for the active project).
- **`CLAUDE.md` editor** — read and edit the project-level memory file directly inside the app.
- **Project rename** — friendly name per project, persisted locally.
- **File viewer/editor** — built-in text editor with image preview for binary assets.
- **Skip-permissions persistence** — the per-project skip-permissions toggle survives restarts.

## Tech stack

- **Shell**: [Tauri 2](https://tauri.app/) (Rust)
- **Frontend**: React + TypeScript + Vite
- **Terminal rendering**: [xterm.js](https://xtermjs.org/)
- **Pixel office engine**: forked from pixel-agents — Canvas 2D, BFS pathfinding, FSM-based character animation

## Repository layout

| Directory     | What lives there                                                                 |
| ------------- | -------------------------------------------------------------------------------- |
| `src-tauri/`  | Rust shell (Tauri commands, process management, file I/O)                        |
| `webview-ui/` | React/Vite frontend (office canvas, terminals, file/memory panes)                |
| `server/`     | Forked HTTP/hooks server — currently unused, kept for future Claude Code Hooks integration |
| `shared/`     | Shared TypeScript types between the webview and (future) server                  |
| `eslint-rules/` | Project-specific lint rules (no inline colors, pixel font, pixel shadows)      |
| `docs/`       | Planning docs, phase specs, master plan                                          |

## Build commands

```bash
npm run dev              # Tauri dev (webview + rust shell)
npm run build            # Tauri release build
npm run lint             # ESLint across server, shared, and webview-ui
npm run test             # Webview + server (Vitest) + Rust (cargo test)
cd src-tauri && cargo test
cd webview-ui && npm run dev   # Webview-only dev (no Tauri shell)
```

## Contributing

This is a personal project under active development; the public API is not yet stable. If you want to follow along or fork it further, the master plan in `docs/superpowers/plans/` is the source of truth for what's shipped and what's next.

## License

[MIT](LICENSE) — same as the upstream `pixel-agents` project. Original copyright retained; modifications are also MIT.
