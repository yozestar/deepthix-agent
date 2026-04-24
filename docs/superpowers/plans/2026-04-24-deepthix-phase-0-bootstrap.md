# Deepthix Agent — Phase 0: Bootstrap & Tauri Shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a fresh fork of pixel-agents, strip the VS Code extension layer, scaffold a Tauri 2 shell around the existing React webview, and have an empty Tauri window that boots and renders the React app with no crashes.

**Architecture:** Use rsync to merge pixel-agents into the existing `deepthix-agent/` directory (which already holds the spec + master plan). Delete VS Code-specific files. Use `tauri init` to scaffold `src-tauri/`. Reuse pixel-agents' existing `runtime.ts` provider-agnostic abstraction by adding a `'tauri'` variant alongside `'vscode'` and `'browser'`. Ship Rust `tracing` logging from day one so every later phase has logs to debug with.

**Tech Stack:** Tauri 2.x, Rust (`tracing`, `tracing-subscriber`, `tracing-appender`), React 19 + TypeScript + Vite (already set up by pixel-agents), `@tauri-apps/api`, `@tauri-apps/cli`.

**Spec:** [`../specs/2026-04-24-deepthix-agent-design.md`](../specs/2026-04-24-deepthix-agent-design.md)
**Master plan:** [`./2026-04-24-deepthix-master-plan.md`](./2026-04-24-deepthix-master-plan.md)

**Working directory for ALL commands in this plan:** `/Users/rubenperez/Sites/localhost/deepthix-agent`

---

## Pre-flight

Confirm starting state:

- [ ] **Step P1: Verify deepthix-agent dir state**

```bash
cd /Users/rubenperez/Sites/localhost/deepthix-agent
ls -la
```

Expected: `.git/` and `docs/` exist. Nothing else.

- [ ] **Step P2: Verify pixel-agents source is present**

```bash
ls /Users/rubenperez/Sites/localhost/pixel-agents/package.json
```

Expected: file exists.

- [ ] **Step P3: Verify Rust + Cargo + Node are installed**

```bash
rustc --version && cargo --version && node --version && npm --version
```

Expected: rustc ≥ 1.77, cargo present, node ≥ 20, npm ≥ 10. If Rust is missing, install via `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.

---

## Task 1: Copy pixel-agents files into deepthix-agent

**Files:**
- Copy: everything from `/Users/rubenperez/Sites/localhost/pixel-agents/` → `/Users/rubenperez/Sites/localhost/deepthix-agent/` *except* `.git`, `node_modules`, `dist`, `src/` (VS Code extension code), `e2e/`, `.vscode/`, `.vscodeignore`, `.vsixmanifest`, `*.vsix`, `esbuild.js`.

- [ ] **Step 1.1: Run the rsync**

```bash
rsync -av \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='/src/' \
  --exclude='/e2e/' \
  --exclude='/.vscode/' \
  --exclude='.vscodeignore' \
  --exclude='.vsixmanifest' \
  --exclude='*.vsix' \
  --exclude='esbuild.js' \
  /Users/rubenperez/Sites/localhost/pixel-agents/ \
  /Users/rubenperez/Sites/localhost/deepthix-agent/
```

Expected: many files transferred. The trailing slashes on both paths matter. **Note the leading `/` on `/src/`, `/e2e/`, `/.vscode/`** — these anchor the patterns to the source root so they do NOT match `webview-ui/src/`, `server/src/`, or any nested `e2e`/`.vscode` dirs.

- [ ] **Step 1.2: Verify the copy**

```bash
ls /Users/rubenperez/Sites/localhost/deepthix-agent/
```

Expected to be present: `webview-ui/`, `server/`, `shared/`, `scripts/`, `package.json`, `package-lock.json`, `README.md`, `LICENSE`, `tsconfig.json`, `eslint.config.mjs`, `.prettierrc.json`, `.gitignore`, `docs/`, `.git/`, `icon.png`, `CHANGELOG.md`, `CLAUDE.md`, etc.

Confirm `src/` and `e2e/` are NOT present:

```bash
test ! -d /Users/rubenperez/Sites/localhost/deepthix-agent/src && \
test ! -d /Users/rubenperez/Sites/localhost/deepthix-agent/e2e && echo "ok"
```

Expected: `ok`.

- [ ] **Step 1.3: Commit the merged tree**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Import pixel-agents source tree (excluding VS Code extension)

Forked from pablodelucca/pixel-agents (MIT). Removed the VS Code
extension layer (src/), Playwright E2E tests (e2e/), and VS Code
config files. Webview-ui, server, and shared packages preserved
unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Strip VS Code references from root package.json

**Files:**
- Modify: `/Users/rubenperez/Sites/localhost/deepthix-agent/package.json`

- [ ] **Step 2.1: Read current package.json**

```bash
cat package.json
```

Note the fields to be removed/changed.

- [ ] **Step 2.2: Replace package.json with cleaned version**

Write this content (preserves original scripts that don't reference VS Code, drops everything else):

```json
{
  "name": "deepthix-agent",
  "displayName": "Deepthix Agent",
  "description": "Standalone macOS app for running and watching Claude Code agents in a pixel art office.",
  "version": "0.1.0",
  "license": "MIT",
  "private": true,
  "type": "module",
  "scripts": {
    "build:webview": "cd webview-ui && npm run build",
    "build:server": "cd server && npm run build",
    "lint": "eslint server shared && cd webview-ui && eslint .",
    "lint:fix": "eslint server shared --fix && cd webview-ui && eslint . --fix",
    "format": "prettier --write \"server/**/*.ts\" \"shared/**/*.ts\" \"webview-ui/src/**/*.{ts,tsx,css}\" \"*.{js,mjs}\" \"webview-ui/*.{js,ts}\"",
    "format:check": "prettier --check \"server/**/*.ts\" \"shared/**/*.ts\" \"webview-ui/src/**/*.{ts,tsx,css}\" \"*.{js,mjs}\" \"webview-ui/*.{js,ts}\"",
    "test:webview": "cd webview-ui && npm test",
    "test:server": "cd server && npm test",
    "test": "npm run test:webview && npm run test:server"
  },
  "devDependencies": {
    "eslint": "^10.0.3",
    "eslint-config-prettier": "^10.1.8",
    "eslint-plugin-simple-import-sort": "^12.1.1",
    "prettier": "^3.8.1",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.54.0"
  }
}
```

Use the `Write` tool to overwrite `package.json` with the above.

- [ ] **Step 2.3: Delete now-orphan files**

```bash
rm -f knip.json .git-blame-ignore-revs .husky/pre-commit .gitleaks.toml
rm -rf .husky .github
```

(`knip.json` and the husky/github actions were extension-specific. We can re-add CI later if needed.)

- [ ] **Step 2.4: Verify install works**

```bash
rm -f package-lock.json
npm install
```

Expected: completes without errors. No mentions of `@types/vscode` or `@vscode/test-electron`.

- [ ] **Step 2.5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Strip VS Code-specific config from root package

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Verify webview-ui builds standalone

**Files:** none modified. This is a verification gate — the webview must still build before we wrap it in Tauri.

- [ ] **Step 3.1: Install webview-ui deps**

```bash
cd webview-ui
npm install
```

Expected: completes without errors.

- [ ] **Step 3.2: Build webview-ui**

```bash
npm run build
```

Expected: TypeScript check passes, vite build emits to `../dist/webview/` (per the existing vite config). Confirm:

```bash
ls ../dist/webview/index.html
```

Expected: file exists.

- [ ] **Step 3.3: Run webview-ui tests**

```bash
npm test
```

Expected: existing pixel-agents tests pass. If any fail because they reference removed code, note them — we'll fix in a later phase. For Phase 0, the bar is **the build succeeds**; test failures here are informational.

- [ ] **Step 3.4: Return to root**

```bash
cd ..
```

---

## Task 4: Verify server/ installs and tests run

In pixel-agents, the server was bundled by the root `esbuild.js` (now removed). The standalone `server/package.json` only defines `test` and `test:watch`. Phase 0 only needs the package to install and the test suite to be runnable; bundling for the Tauri sidecar lands in Phase 5.

- [ ] **Step 4.1: Install server deps**

```bash
cd server
npm install
```

- [ ] **Step 4.2: Run server tests**

```bash
npm test
```

Expected: vitest loads the existing pixel-agents server tests. **Known failure (informational, not a Phase 0 blocker):** the suite `__tests__/hookEventHandler.test.ts` will fail to load because `server/src/hookEventHandler.ts` imports `cancelPermissionTimer`, `cancelWaitingTimer` from `../../src/timerManager.js` and the `AgentState` type from `../../src/types.js` — root `src/` was deleted in Task 1. The other ~6 suites (~97 tests) should pass. We will repair this coupling when we re-house the hook server as a Tauri sidecar in Phase 5 (move the timer module / types into `server/src/` or `shared/`).

- [ ] **Step 4.3: Return to root and commit lock files**

```bash
cd ..
git add -A
git commit -m "$(cat <<'EOF'
chore: regenerate lock files after removing VS Code deps

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add Tauri CLI + JS API to root

**Files:**
- Modify: `package.json` (add devDependencies + dependencies)

- [ ] **Step 5.1: Install Tauri CLI at root (devDep)**

```bash
npm install --save-dev @tauri-apps/cli@^2
```

Expected: `package.json` now has `@tauri-apps/cli` in `devDependencies`.

- [ ] **Step 5.1b: Install Tauri JS API inside webview-ui**

The webview-ui is its own npm project (`webview-ui/package.json`). `@tauri-apps/api` is imported from `webview-ui/src/tauriApi.ts` (added in Task 8), so it must be a dep of webview-ui directly.

```bash
cd webview-ui
npm install --save @tauri-apps/api@^2
cd ..
```

Expected: `webview-ui/package.json` has `@tauri-apps/api` in `dependencies`.

- [ ] **Step 5.2: Verify the Tauri CLI works**

```bash
npx tauri --version
```

Expected: prints `tauri-cli 2.x.x`.

---

## Task 6: Initialize src-tauri/ with `tauri init`

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/icons/` (defaults), `src-tauri/.gitignore`.

`tauri init` is interactive. We pass non-interactive flags to set everything in one shot.

- [ ] **Step 6.1: Run tauri init**

```bash
npx tauri init \
  --app-name "Deepthix Agent" \
  --window-title "Deepthix Agent" \
  --frontend-dist "../dist/webview" \
  --dev-url "http://localhost:1420" \
  --before-dev-command "cd webview-ui && npm run dev" \
  --before-build-command "npm run build:server && npm run build:webview" \
  --identifier "dev.deepthix.agent" \
  --ci
```

Expected: creates `src-tauri/` with the listed files. Default app/lib name is derived from `app-name`.

- [ ] **Step 6.2: Verify scaffold**

```bash
ls src-tauri/ && cat src-tauri/tauri.conf.json
```

Expected: directories `src/`, `icons/`, `capabilities/`; files `Cargo.toml`, `tauri.conf.json`, `build.rs`. The `tauri.conf.json` contains the `productName`, `identifier`, `frontendDist`, `devUrl`, etc. as set above.

- [ ] **Step 6.3: Commit scaffold**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Scaffold Tauri 2 src-tauri/ via tauri init

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Align webview-ui Vite config with Tauri's expectations

**Files:**
- Modify: `webview-ui/vite.config.ts`

Tauri 2 expects the dev server to run on a known port and not clear the terminal (so Tauri's logs stay visible). The current pixel-agents vite config does not pin a port.

- [ ] **Step 7.1: Read existing vite config**

```bash
sed -n '1,60p' webview-ui/vite.config.ts
```

Note the existing `defineConfig({...})` block.

- [ ] **Step 7.2: Add Tauri-friendly settings**

Find the `defineConfig({` call in `webview-ui/vite.config.ts` and add these top-level keys (do not remove existing keys; merge in):

```ts
defineConfig({
  // ... existing keys (plugins, etc.) ...

  // Tauri integration
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'safari15', // matches macOS WKWebView
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
```

If the existing config already has a `build` key, **merge** the new fields into it rather than overwriting.

- [ ] **Step 7.3: Test the dev server still launches**

```bash
cd webview-ui
timeout 10 npm run dev
```

Expected: vite starts on `http://127.0.0.1:1420`. After ~10s the timeout will kill it; that's fine.

- [ ] **Step 7.4: Commit**

```bash
cd ..
git add webview-ui/vite.config.ts
git commit -m "$(cat <<'EOF'
Pin Vite to port 1420 for Tauri integration

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Add 'tauri' runtime variant + tauriApi wrapper in webview

**Files:**
- Modify: `webview-ui/src/runtime.ts`
- Create: `webview-ui/src/tauriApi.ts`
- Modify: `webview-ui/src/vscodeApi.ts` (rename in next phase; for Phase 0 it stays)

The existing `runtime.ts` already supports `'vscode' | 'browser'`. We add `'tauri'` and detect it via `window.__TAURI_INTERNALS__` (Tauri 2's injected global).

- [ ] **Step 8.1: Rewrite runtime.ts**

Overwrite `webview-ui/src/runtime.ts` with:

```ts
/**
 * Runtime detection, provider-agnostic.
 *
 * Determines whether the webview is running inside an IDE extension,
 * a Tauri desktop app, or standalone in a browser.
 */

declare function acquireVsCodeApi(): unknown;

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

type Runtime = 'vscode' | 'tauri' | 'browser';

function detectRuntime(): Runtime {
  if (typeof acquireVsCodeApi !== 'undefined') return 'vscode';
  if (typeof window !== 'undefined' && (window as TauriWindow).__TAURI_INTERNALS__) {
    return 'tauri';
  }
  return 'browser';
}

const runtime: Runtime = detectRuntime();

export const isBrowserRuntime = runtime === 'browser';
export const isTauriRuntime = runtime === 'tauri';
export const isVscodeRuntime = runtime === 'vscode';
export { runtime };
```

- [ ] **Step 8.2: Write a unit test for detection**

Create `webview-ui/test/runtime.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('detectRuntime falls back to browser when neither vscode nor tauri globals exist', async () => {
  // The module reads globals at import time; this test exists to lock the
  // logic in place. The actual detection paths are exercised at runtime.
  const mod = await import('../src/runtime.ts');
  assert.equal(typeof mod.runtime, 'string');
  assert.ok(['vscode', 'tauri', 'browser'].includes(mod.runtime));
  assert.equal(mod.isBrowserRuntime, mod.runtime === 'browser');
  assert.equal(mod.isTauriRuntime, mod.runtime === 'tauri');
  assert.equal(mod.isVscodeRuntime, mod.runtime === 'vscode');
});
```

- [ ] **Step 8.3: Run the test**

```bash
cd webview-ui && npm test -- --test-name-pattern "detectRuntime"
```

Expected: passes.

- [ ] **Step 8.4: Create tauriApi.ts**

Create `webview-ui/src/tauriApi.ts`:

```ts
/**
 * Thin Tauri IPC wrapper, mirrors the shape of vscodeApi.ts so call sites
 * can switch on runtime cleanly. Phase 0 only stubs out postMessage —
 * real command/event wiring lands in later phases.
 */
import { isTauriRuntime } from './runtime';

interface MessageBridge {
  postMessage(msg: unknown): void;
}

async function getTauri(): Promise<typeof import('@tauri-apps/api/core') | null> {
  if (!isTauriRuntime) return null;
  return await import('@tauri-apps/api/core');
}

export const tauri: MessageBridge = {
  postMessage(msg: unknown): void {
    // Phase 0: log only. Future phases will route specific message types
    // to typed Tauri commands via invoke().
    void getTauri().then((mod) => {
      if (mod) {
        // eslint-disable-next-line no-console
        console.log('[Deepthix][tauri.postMessage]', msg);
      }
    });
  },
};
```

- [ ] **Step 8.5: Update vscodeApi.ts to delegate to tauri when in Tauri**

Overwrite `webview-ui/src/vscodeApi.ts`:

```ts
import { isBrowserRuntime, isTauriRuntime } from './runtime';
import { tauri } from './tauriApi';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

function makeBridge(): { postMessage(msg: unknown): void } {
  if (isTauriRuntime) return tauri;
  if (isBrowserRuntime) {
    return { postMessage: (msg: unknown) => console.log('[Deepthix][bridge.browser]', msg) };
  }
  return acquireVsCodeApi() as { postMessage(msg: unknown): void };
}

// Name kept as `vscode` to avoid touching every call site in this phase.
// Real renaming/typed IPC lands in later phases.
export const vscode: { postMessage(msg: unknown): void } = makeBridge();
```

- [ ] **Step 8.6: Run the webview build**

```bash
npm run build
```

Expected: typecheck passes, build succeeds. The `@tauri-apps/api` dep was added in Task 5.1b directly to `webview-ui/package.json`, so the import resolves locally.

- [ ] **Step 8.7: Commit**

```bash
cd ..
git add -A
git commit -m "$(cat <<'EOF'
Add 'tauri' runtime variant and tauriApi.ts bridge stub

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Set up Rust tracing logging

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/log.rs`
- Modify: `src-tauri/src/lib.rs`

Logging in from day one so the rest of the project has it.

- [ ] **Step 9.1: Add tracing deps to Cargo.toml**

Open `src-tauri/Cargo.toml`. Find the `[dependencies]` section and add:

```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt"] }
tracing-appender = "0.2"
dirs = "5"
```

(`dirs` is the standard crate for finding `~/`.)

- [ ] **Step 9.2: Create src-tauri/src/log.rs**

```rust
use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

/// Initializes tracing to log to stderr AND to a daily-rotated file at
/// `~/.deepthix/logs/deepthix-YYYY-MM-DD.log`. Returns the worker guard;
/// the caller MUST keep it alive for the program lifetime, otherwise
/// the file logger is dropped.
pub fn init() -> WorkerGuard {
    let log_dir = log_dir();
    std::fs::create_dir_all(&log_dir).expect("create log dir");

    let file_appender = tracing_appender::rolling::daily(&log_dir, "deepthix.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = EnvFilter::try_from_env("DEEPTHIX_LOG")
        .or_else(|_| EnvFilter::try_new("info,deepthix=debug"))
        .unwrap();

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt::layer().with_target(true).with_writer(std::io::stderr))
        .with(fmt::layer().with_target(true).with_ansi(false).with_writer(file_writer))
        .init();

    tracing::info!(target: "deepthix::boot", path = ?log_dir, "logging initialized");
    guard
}

pub fn log_dir() -> PathBuf {
    dirs::home_dir()
        .expect("home dir")
        .join(".deepthix")
        .join("logs")
}
```

- [ ] **Step 9.3: Wire logging into lib.rs**

Open `src-tauri/src/lib.rs` (created by `tauri init`). Replace its contents with:

```rust
mod log;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _log_guard = log::init();
    tracing::info!(target: "deepthix::boot", version = env!("CARGO_PKG_VERSION"), "starting Deepthix Agent");

    tauri::Builder::default()
        .setup(|_app| {
            tracing::info!(target: "deepthix::boot", "tauri setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 9.4: Verify it compiles**

```bash
cd src-tauri && cargo build && cd ..
```

Expected: compiles. May take a few minutes the first time (downloading crates).

- [ ] **Step 9.5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add tracing-based logging in Rust, write to ~/.deepthix/logs/

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update root package.json scripts to drive Tauri

**Files:**
- Modify: `package.json`

- [ ] **Step 10.1: Add Tauri scripts**

Find the `"scripts"` block in root `package.json` and replace with:

```json
"scripts": {
  "dev": "tauri dev",
  "build": "tauri build",
  "build:webview": "cd webview-ui && npm run build",
  "build:server": "cd server && npm run build",
  "tauri": "tauri",
  "lint": "eslint server shared && cd webview-ui && eslint .",
  "lint:fix": "eslint server shared --fix && cd webview-ui && eslint . --fix",
  "format": "prettier --write \"server/**/*.ts\" \"shared/**/*.ts\" \"webview-ui/src/**/*.{ts,tsx,css}\" \"*.{js,mjs}\" \"webview-ui/*.{js,ts}\"",
  "format:check": "prettier --check \"server/**/*.ts\" \"shared/**/*.ts\" \"webview-ui/src/**/*.{ts,tsx,css}\" \"*.{js,mjs}\" \"webview-ui/*.{js,ts}\"",
  "test:webview": "cd webview-ui && npm test",
  "test:server": "cd server && npm test",
  "test:rust": "cd src-tauri && cargo test",
  "test": "npm run test:webview && npm run test:server && npm run test:rust"
}
```

- [ ] **Step 10.2: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
Wire root npm scripts through tauri CLI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Smoke test — launch the app

**Files:** none modified. This is the Phase 0 acceptance test.

- [ ] **Step 11.1: Launch dev mode**

```bash
npm run dev
```

This will:
1. Start vite on `http://127.0.0.1:1420` (via the `beforeDevCommand`).
2. Build the Rust binary (slow first time).
3. Open a Tauri window.

- [ ] **Step 11.2: Verify the window**

The macOS window titled "Deepthix Agent" should appear. The pixel-art office canvas (or some part of the React app) should render. **It is OK if it looks broken/empty/error-y** — assets, agent connections, and the new sidebar/bottom panel haven't been wired up yet. The bar for Phase 0 is:

- The window opens.
- Webview reaches React render (you see *something* React rendered, not a Tauri error page).
- No Rust panics in stderr.

- [ ] **Step 11.3: Verify the log file was created**

In a second terminal:

```bash
ls ~/.deepthix/logs/ && tail -20 ~/.deepthix/logs/deepthix.log.*
```

Expected: a log file exists and contains entries with target `deepthix::boot`, including `"starting Deepthix Agent"` and `"tauri setup complete"`.

- [ ] **Step 11.4: Quit the app and capture a screenshot**

Cmd+Q the window. Take a screenshot for the record (Cmd+Shift+4) and save it to `docs/superpowers/specs/phase-0-smoke.png` (optional — for tracking progress visually).

---

## Task 12: Add an end-of-phase tag and update master plan

- [ ] **Step 12.1: Tag the commit**

```bash
git tag deepthix-phase-0-done
```

- [ ] **Step 12.2: Update master plan**

Open `docs/superpowers/plans/2026-04-24-deepthix-master-plan.md` and confirm Phase 0's row in the Phase Map points to `2026-04-24-deepthix-phase-0-bootstrap.md` (it already should). No changes expected — this step is just to verify.

---

## Phase 0 — Definition of Done

- [ ] `git log --oneline` shows commits for tasks 1, 2, 4, 6, 7, 8, 9, 10.
- [ ] `git tag --list` shows `deepthix-phase-0-done`.
- [ ] `npm install` at root succeeds.
- [ ] `npm run build:webview` succeeds.
- [ ] `npm run build:server` succeeds.
- [ ] `cd src-tauri && cargo build` succeeds.
- [ ] `npm run dev` opens a Tauri window with the React app rendering.
- [ ] `~/.deepthix/logs/deepthix.log.*` contains boot logs.
- [ ] `webview-ui/src/runtime.ts` exports `isTauriRuntime`.
- [ ] `webview-ui/src/tauriApi.ts` exists.
- [ ] No file under `src/` exists (the old VS Code extension dir should be gone).
- [ ] No file in the repo references `acquireVsCodeApi()` outside of `runtime.ts` and `vscodeApi.ts`. Verify with:
  ```bash
  grep -rn "acquireVsCodeApi" --include="*.ts" --include="*.tsx" .
  ```
  Should output exactly two files.

When all the above are checked, Phase 0 is done. Invoke `superpowers:writing-plans` to write the Phase 1 plan (`2026-04-24-deepthix-phase-1-projects-sidebar.md`) which adds Open Folder, project list, project switching, and the sidebar.
