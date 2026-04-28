# Deepthix Agent

Standalone macOS desktop app for running and watching [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions in a tamagotchi-style office. Each project becomes a little world: agents are characters, sessions are rolling balls, and your `CLAUDE.md` lives one keystroke away.

This project is a fork of [pixel-agents](https://github.com/pablodelucca/pixel-agents) by [@pablodelucca](https://github.com/pablodelucca) (MIT). The original is a VS Code extension that visualizes Claude Code agents in a pixel art office; Deepthix Agent rebuilds that vision as a standalone Tauri desktop app with a project-centric workflow. Full credit to the original author for the pixel office, asset pipeline, and JSONL parsing primitives this app is built on.

## Status

Under active development. Architecture overview in [`CLAUDE.md`](CLAUDE.md).

## Download

Pre-built installers ship on the [Releases page](https://github.com/deepthix/deepthix-agent/releases). Pick the artifact for your machine:

| Platform                          | Download                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **macOS — Apple Silicon (M1+)**   | [`Deepthix Agent_*_aarch64.dmg`](https://github.com/deepthix/deepthix-agent/releases/latest)                          |
| **macOS — Intel**                 | [`Deepthix Agent_*_x64.dmg`](https://github.com/deepthix/deepthix-agent/releases/latest)                              |
| **Windows x64 (NSIS installer)**  | [`Deepthix Agent_*_x64-setup.exe`](https://github.com/deepthix/deepthix-agent/releases/latest)                        |
| **Windows x64 (MSI installer)**   | [`Deepthix Agent_*_x64_en-US.msi`](https://github.com/deepthix/deepthix-agent/releases/latest)                        |

The app isn't code-signed yet, so:

- **macOS**: right-click the .app the first time → "Open" → "Open" in the dialog.
- **Windows**: SmartScreen will warn → "More info" → "Run anyway".

After install, [Claude Code](https://docs.anthropic.com/en/docs/claude-code) must be on your PATH (`brew install anthropic/anthropic/claude` on macOS, or follow the docs for Windows).

## Quick start (dev)

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
| `docs/`       | External-asset attribution and other public docs                                 |
| `.github/`    | Release pipeline (auto-builds macOS Intel/ARM + Windows on every `v*` tag)      |

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

Personal project, public API not yet stable. PRs welcome on bugs you actually hit; please open an issue for any feature work first so we don't both ship the same thing.

## Releases

Tagging a `v*` commit automatically triggers `.github/workflows/release.yml`, which builds macOS Apple Silicon, macOS Intel, and Windows x64 in parallel and attaches the artifacts to a draft release. Bump the version in `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`, then:

```bash
git tag v0.X.Y
git push origin v0.X.Y
# Wait ~15 min, review the draft release on GitHub, click Publish.
```

## License

[MIT](LICENSE) — same as the upstream `pixel-agents` project. Original copyright retained; modifications are also MIT.
