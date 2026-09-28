# Elyone AI Desktop Agent

Desktop workspace to run and follow several AI agent sessions side by side: conversation-style sidebar with every project and session, persisted history, reusable workflows, shared variables and per-project dashboards. Windows + macOS.

Internal Elyone tool. Visual identity follows the ELYONE Global Product Design System (brand blue, light theme by default, navy dark mode).

## Status

Active development on the `local-deploy` branch. Architecture overview in [`CLAUDE.md`](CLAUDE.md).

## Install

Installers are built from source (see *Quick start* and *Releases* below). On Windows, SmartScreen may warn on first launch → "More info" → "Run anyway".

The agent CLI must be on your `PATH`. For voice transcription you also need `whisper-cpp` and `ffmpeg`.

## Quick start (dev)

```bash
git clone https://github.com/yozestar/deepthix-agent.git elyone-desktop-agent
cd elyone-desktop-agent
npm install
cd webview-ui && npm install --legacy-peer-deps && cd ..
npm run dev
```

`npm run dev` launches Tauri in dev mode (Vite for the webview, `cargo run` for the Rust shell). First Rust build takes a few minutes; subsequent rebuilds are incremental.

## Features

### Sessions

- **Stream-json chat** — claude runs in `--print --input-format stream-json` mode, rendered in a custom React UI. No xterm, no Ink TUI, no cell-bleed bugs. Parallel sessions in sub-tabs, full conversation history hydrated from `~/.claude/projects/<hash>/*.jsonl` on reopen.
- **Working slash commands in chat-mode** — `/help`, `/clear`, `/cost`, `/usage`, `/model`, `/agents`, `/privacy`, `/upgrade` plus the chat-mode-only `/resume` (picker over every saved session, click to switch) and `/rewind <N>` (truncates the JSONL by N user turns and respawns claude on the rewound state).
- **Stop = stop the turn** — the Stop button SIGINTs claude and immediately respawns with `--resume` so the conversation context is preserved.
- **Drag-drop attachments** — drop images on the window; they're staged as preview thumbnails next to the composer with a × to remove individuals. Send when you're ready, no auto-fire.
- **Voice → composer** — hold ⌘M (or click the mic) to record; transcription via local whisper.cpp lands in the textarea (review/edit before sending). Multiple recordings accumulate.

### Coach (global, Sonnet)

A second claude session running in the background that reviews every active session in every project every 10 min. State lives at `~/.deepthix/coach.json`; messages persist at `~/.deepthix/coach-messages.json`. The coach can emit three card types:

- **`<proposal>`** — a memory rule worth pinning to your project's `CLAUDE.md`. Click Yes → appended automatically.
- **`<schedule>`** — a recurring or one-shot job. Click Yes → a schedule is created against the project's first claude session.
- **`<workflow>`** — a saved prompt recipe. Click Yes → added to your workflow catalog (see below) and runnable in one click.

The coach also has direct tool access — when it spots something worth pinning to the project dashboard, it writes it itself via `$DEEPTHIX_DASHBOARD_PATH`.

### Top tabs

| Tab          | What it does |
| ------------ | ------------ |
| **OVERVIEW** | Per-project HTML dashboard rendered in a sandboxed iframe. Any session can `Write` to `$DEEPTHIX_DASHBOARD_PATH` to update it. Buttons with `data-deepthix-action` get auto-wired to fire prompts back into the session. |
| **SESSIONS** | The chat surface — sub-tabs per session + the Coach pane on top. |
| **FILES**    | Project file tree + viewer/editor with image preview, PDF viewer, video preview. |
| **PROCESS**  | Live process list with kill buttons (catches dev servers / orphan node procs). |
| **MEMORY**   | `CLAUDE.md` editor for the active project. |
| **SKILLS**   | Project-level claude code skills (`.claude/skills/*.skill`). |
| **SCHEDULE** | Recurring or one-shot claude jobs. Cadence = every-N-minutes / every-N-hours / every-N-days, or a one-shot at a chosen datetime. |
| **WORKFLOW** | Saved prompt recipes. Two-column UI: list + editor (auto-save). ▶ Run opens a fresh session in the active project, ships the prompt as the first message, logs the run to `~/.deepthix/workflows/<id>/runs.jsonl`. Claude can also manage entries via Read/Write on the catalog. |
| **VARIABLES** | Shared key/value scratchpad both you and claude can read or write. Inline edit, debounced auto-save, polls every 5 s for changes claude makes. |
| **SETTINGS** | Theme picker (8 presets), box-style picker (5: pixel / glass / flat / soft / neon), terminal font config, About. |

### Per-session usage panel

Live OAuth limits scraped from the same endpoint claude.ai uses (`/api/oauth/usage`). Snapshot from claude code's statusLine takes priority when available, falls back to the OAuth call when stale, falls back to the last cached reading when both are unreachable. Includes a debug button that dumps every bucket the API actually returned.

### Claude integration — env vars

Every claude session (chat + pty + scheduled run + coach) is spawned with these env vars, plus a brief auto-injected into `~/.claude/CLAUDE.md` so claude knows what they're for:

| Env var                       | Purpose                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `$DEEPTHIX_PROJECT_ID`        | Stable id of the running project.                                                |
| `$DEEPTHIX_DASHBOARD_PATH`    | Project-level `dashboard.html`. Use `Write` to publish a status board for the OVERVIEW tab. |
| `$DEEPTHIX_WORKFLOWS_PATH`    | `workflows.json` catalog. Read to discover, Edit/Write to add/modify entries.    |
| `$DEEPTHIX_VARIABLES_PATH`    | `variables.json` scratchpad. Look it up before asking the user a clarifying question. |
| `$DEEPTHIX_SESSION_ID`        | Claude session UUID (pty mode only — chat mode emits this via system/init).      |

### Themes + box styles

8 colour themes (Pixel default, Dracula, Nord, Tokyo Night, Catppuccin Mocha, Gruvbox Dark, Monokai, Solarized Dark) × 5 box styles (Pixel hard-shadow, Glass with backdrop blur, Flat, Soft rounded, Neon glow). Each theme defines `--color-session-active` distinct from `--color-accent` so the active session stands out from CTA buttons (60-30-10 colour rule + tmux active-pane convention).

## Storage

Everything lives under `~/.deepthix/`:

```
~/.deepthix/
├── config.json                   # global app config (theme, fonts, box-style)
├── coach.json                    # coach state (enabled, session_id, last_run_ms)
├── coach-messages.json           # coach conversation log (persists across reloads)
├── coach-workspace/              # cwd the coach Sonnet is spawned in
├── workflows.json                # saved prompt recipes
├── workflows/<id>/runs.jsonl     # per-workflow run log
├── variables.json                # shared key/value scratchpad
├── usage-snapshot.json           # statusline-dumper snapshot for live limits
└── projects/<id>/
    ├── coach.json                # legacy per-project state (kept for migration)
    ├── coach-messages.json       # legacy per-project messages
    ├── dashboard.html            # the project's OVERVIEW iframe content
    └── (other per-project state)
```

Claude session transcripts stay where claude code writes them: `~/.claude/projects/<hash>/<uuid>.jsonl`.

## Tech stack

- **Shell**: [Tauri 2](https://tauri.app/) (Rust)
- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS 4
- **Markdown**: react-markdown + remark-gfm
- **PDF preview**: react-pdf
- **Voice**: whisper.cpp (local) + ffmpeg
- **Shell terminals**: xterm.js (claude sessions don't use it — they're stream-json)

## Repository layout

| Directory       | What lives there                                                                 |
| --------------- | -------------------------------------------------------------------------------- |
| `src-tauri/`    | Rust shell — Tauri commands, JSONL watcher, PTY manager, ChatManager, scheduler. |
| `webview-ui/`   | React/Vite frontend — every pane component, hooks, command wrappers.              |
| `server/`       | Forked HTTP/hooks server. Currently unused; kept for the future Hooks integration. |
| `shared/`       | Shared TypeScript types between the webview and (future) server.                  |
| `eslint-rules/` | Project-specific lint rules (no inline colour literals, pixel font, pixel shadow). |
| `docs/`         | External-asset attribution + plans/specs.                                         |
| `.github/`      | Release pipeline (auto-builds macOS Intel/ARM + Windows on every `v*` tag).       |

## Build commands

```bash
npm run dev            # Tauri dev (webview + rust shell)
npm run build          # Tauri release build for the current platform
npm run lint           # ESLint across server, shared, and webview-ui
npm run test           # Webview + server (Vitest) + Rust (cargo test)
cd src-tauri && cargo test
cd webview-ui && npm run dev   # Webview-only dev (no Tauri shell)
```

## Releases

Installers for every platform are built by `.github/workflows/build-installers.yml` (manual trigger: Actions → "Build installers" → Run workflow). It produces one downloadable artifact per platform on the run page — macOS Apple Silicon, macOS Intel, Windows x64, Windows ARM64 — without publishing anything. Installers are unsigned.

Local builds (Windows):

```bash
npm run build                                          # host architecture
npx tauri build --target x86_64-pc-windows-msvc        # Windows x64 from an ARM64 machine
```

Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` before a build you intend to distribute.

## Contributing

Personal project, public API not stable yet. PRs welcome on bugs you actually hit; please open an issue for any feature work first so we don't both ship the same thing.

## License + attribution

[MIT](LICENSE) — same as the upstream projects.

This codebase started as a fork of **Deepthix Agent**, itself a fork of [pixel-agents](https://github.com/pablodelucca/pixel-agents) by [@pablodelucca](https://github.com/pablodelucca) (a VS Code extension that visualises agents in a pixel-art office). It reuses the JSONL parsing primitives, the asset pipeline and several utility components, rebuilt as a standalone Tauri desktop app. The original MIT copyright notice is kept in [LICENSE](LICENSE). Full credit and thanks to the original authors.
