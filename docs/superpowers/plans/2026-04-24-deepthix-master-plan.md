# Deepthix Agent — Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Tauri macOS app forked from Pixel Agents that lets the user run, watch, and manage Claude Code agents without Cursor.

**Architecture:** Fork pixel-agents, strip the VS Code extension layer, wrap the React webview in a Tauri 2 shell. Add a Rust backend for pty/file-watching/IPC. Re-house the existing Node hook server as a Tauri sidecar. Add a sidebar (projects + file tree), a slide-up bottom panel (terminals + read-only code viewer), and per-project state persistence.

**Tech Stack:** Tauri 2, Rust (`portable-pty`, `notify`, `tracing`), React 19 + TypeScript + Vite, xterm.js, Shiki, Node.js sidecar.

**Spec:** [`docs/superpowers/specs/2026-04-24-deepthix-agent-design.md`](../specs/2026-04-24-deepthix-agent-design.md)

---

## Phase Map

The work is split into 10 phases. Each produces working, demoable software and gets its own detailed plan written before it begins. Phases must run in order (dependencies are linear).

| # | Phase | Plan file | Outcome |
|---|-------|-----------|---------|
| 0 | Bootstrap & Tauri shell | [`2026-04-24-deepthix-phase-0-bootstrap.md`](./2026-04-24-deepthix-phase-0-bootstrap.md) | ✅ Done. Fresh fork, VS Code stripped, Tauri scaffold, empty Tauri window boots and renders the existing pixel-art canvas with no data. Tag: `deepthix-phase-0-done`. |
| 1 | Projects + sidebar | [`2026-04-24-deepthix-phase-1-projects-sidebar.md`](./2026-04-24-deepthix-phase-1-projects-sidebar.md) | ✅ Done. Open Folder works. Sidebar shows project list + active project file tree. Can switch projects. State persisted to `~/.deepthix/projects.json`. Tag: `deepthix-phase-1-done`. |
| 2 | Pixel office wired | TBD | Asset loading via Tauri commands. Office renders properly, all sprites/floors/walls load. Layout editor still works, persists per-project. |
| 3 | Terminals (pty + xterm) | TBD | `+ Agent` spawns a pty running a shell (placeholder for `claude`). Bottom panel slides up with xterm.js. PTY round-trip works. |
| 4 | Agents + JSONL watcher | TBD | Spawn replaced with `claude --session-id <uuid>`. Rust JSONL watcher feeds animations into the office. Heuristic-mode agent visualization works end-to-end. |
| 5 | Hook server sidecar | TBD | Node `server/` runs as Tauri sidecar with crash-restart. Hook installer wires Claude Code → sidecar → Rust → office. Hooks-mode visualization (instant, accurate). |
| 6 | Code viewer | TBD | Click a file → bottom panel viewer tab opens with Shiki-highlighted read-only contents. |
| 7 | Per-project state persistence | TBD | Each project remembers its layout, agents, open terminals, last-viewed file. Switching projects fully restores state. |
| 8 | Unified logging | TBD | Rust + Node sidecar + frontend logs all funnel into a single rotating `~/.deepthix/logs/deepthix.YYYY-MM-DD.log`. Settings has "Open Log File" button. |
| 9 | Rebrand & polish | TBD | All `pixel-agents` references → `deepthix-agent`. New icon. README rewritten. LICENSE attribution preserved. Production `tauri build` produces a runnable `.app`. |

## Dependency rules

- Phase N depends on Phases 0..N-1.
- Within a phase, tasks must be executed in order unless explicitly noted.
- Each phase ends with a manual smoke test + a clean commit on `main`.

## After each phase

When a phase plan is fully checked off:

1. Run the phase's smoke test from its plan.
2. Commit any pending work.
3. Tag the commit: `git tag deepthix-phase-N-done`.
4. Invoke `superpowers:writing-plans` to write the next phase's detailed plan.
5. Update this master plan: replace the next phase's "TBD" with its filename.

## Reference materials per phase

- Phase 0–2: spec sections "Project Location", "Project Structure", "UI Layout", "Migration Steps 1-5".
- Phase 3–5: spec sections "Architecture", "Data flow", "Hook installer", "Sidecar lifecycle".
- Phase 6: spec section "UI Layout > Bottom panel" + Shiki docs.
- Phase 7: spec section "Storage".
- Phase 8: spec section "Logging".
- Phase 9: spec sections "Rebrand", "Build & Dev".
