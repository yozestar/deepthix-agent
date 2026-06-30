// Stream-JSON chat backend.
//
// Replaces the PTY-based interactive `claude` for the SESSIONS view.
// Instead of running `claude` in a tty and embedding its Ink TUI in
// xterm.js (which we kept hitting cell-bleed / glyph-drift problems
// with), we spawn:
//
//   claude --print
//          --output-format stream-json
//          --input-format  stream-json
//          --verbose
//          [--resume <session_id>]
//
// stdin/stdout become a bidirectional newline-delimited JSON channel.
// Each JSON line we read is forwarded to the webview as a
// `chat_event` Tauri event. The frontend builds its own UI from those
// events — no xterm involved, no Ink rendering, no terminal artifacts
// to chase.
//
// Inputs we accept on stdin: `{"type":"user","message":{"role":"user","content":"..."}}`
// Outputs we forward to the UI: every JSON line claude emits — system
// init, tool_use blocks, assistant text deltas, result envelope,
// rate_limit_event, hook_started/hook_response, etc. The frontend
// parses what it needs.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Stdio};
#[cfg(unix)]
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// Default: idle reaper is OFF. Earlier versions reaped at 30 min, but
// that interacted badly with the FE's auto-respawn-on-idle path: a
// session quietly waiting for the user's next message would be killed,
// the FE would respawn it, and the cycle would repeat indefinitely
// (visible flicker of "session paused / session reprise"). Sessions
// now live until the user closes the tab or the app exits; the
// kill_all_blocking exit hook still prevents claude orphans.
//
// Power users can opt back into reaping by setting
// DEEPTHIX_IDLE_TIMEOUT_MS to a positive value (in ms).
pub const DEFAULT_IDLE_TIMEOUT_MS: i64 = 0;
pub const IDLE_REAPER_TICK_SECS: u64 = 60;
/// Refuse new spawns once this many chat sessions are alive in
/// ChatManager. Each claude process holds 200-250 MB resident; one
/// user accumulated 9 stale sessions ≈ 1.95 GB before macOS started
/// thrashing. Six is a generous ceiling — most workflows need 1-3
/// active conversations at a time.
// Default cap on concurrent claude sessions. Was 6 (upstream
// default) but the operator-mode user reported running 20 projects
// in parallel — opening project #7 silently failed because chat_spawn
// refused with "Too many active sessions". Each claude process is
// ~200 MB RAM, so 20 = ~4 GB which is fine on modern dev machines;
// users with less RAM can lower it via Settings → SESSIONS.
pub const MAX_ACTIVE_SESSIONS: usize = 20;

// Reads DEEPTHIX_IDLE_TIMEOUT_MS at boot. Accepts any i64; values <= 0
// disable the reaper entirely (sessions live until app exit). Falls
// back to DEFAULT_IDLE_TIMEOUT_MS if unset or unparseable.
pub fn idle_timeout_ms() -> i64 {
    match std::env::var("DEEPTHIX_IDLE_TIMEOUT_MS") {
        Ok(s) if s.trim().is_empty() => DEFAULT_IDLE_TIMEOUT_MS,
        Ok(s) => match s.trim().parse::<i64>() {
            Ok(v) => v,
            Err(_) => {
                tracing::warn!(
                    target: "deepthix::chat",
                    raw = %s,
                    "DEEPTHIX_IDLE_TIMEOUT_MS not parseable as i64 — using default",
                );
                DEFAULT_IDLE_TIMEOUT_MS
            }
        },
        Err(_) => DEFAULT_IDLE_TIMEOUT_MS,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── Types ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatSpawnArgs {
    /// Working directory the claude process will be spawned in. Behaves
    /// like `cd <cwd> && claude ...` so file edits and skill discovery
    /// are scoped to the user's project.
    pub cwd: PathBuf,
    /// If present, claude resumes the session with this UUID instead of
    /// starting fresh — same semantics as the existing PTY flow.
    #[serde(default)]
    pub resume_session_id: Option<String>,
    /// Forwarded as `--dangerously-skip-permissions`. The user opts in
    /// per-project in the sidebar.
    #[serde(default)]
    pub skip_permissions: bool,
    /// Optional model override forwarded as `--model`. None → claude
    /// uses its default.
    #[serde(default)]
    pub model: Option<String>,
    /// Optional reasoning effort forwarded as `--effort`. Valid values
    /// per `claude --help`: low | medium | high | xhigh | max. None →
    /// claude uses its default for the chosen model.
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatSpawnResult {
    /// In-memory id of this child process. The webview holds it and
    /// uses it for `chat_send` / `chat_kill`.
    pub term_id: String,
    /// claude's session UUID is only known after the first `system/init`
    /// line, so we resolve it asynchronously and emit it via
    /// `chat_event` later. None at spawn time.
    pub session_id: Option<String>,
}

/// Payload of the per-line `chat_event` Tauri event.
#[derive(Debug, Serialize, Clone)]
pub struct ChatEvent {
    pub term_id: String,
    /// Raw JSON line as claude wrote it. The frontend parses by
    /// `payload.line`'s shape. Keeping the raw string instead of
    /// parsing here means we don't have to update Rust types every
    /// time claude code adds a new event subtype.
    pub line: String,
    /// Stream marker — "stdout" or "stderr". stderr lines are claude's
    /// own warnings (rate limits hit, retry messages); we forward them
    /// as a separate stream so the UI can display them differently.
    pub stream: &'static str,
}

// ─── Per-process state ───────────────────────────────────────────────────

struct ChatChild {
    child: Child,
    /// Wrapped writer. Writing must be serialized — concurrent writes
    /// would interleave bytes mid-line and break claude's JSON parser.
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Session UUID claude assigned in its system/init event. Filled
    /// in asynchronously by the webview via chat_set_session_id once it
    /// parses the init line. Used by the scheduler to resolve a stable
    /// session_id back to a live term_id.
    session_id: Option<String>,
    /// Working directory the child was spawned in. Cached so
    /// `chat_switch_model` can respawn with the same cwd without the
    /// caller having to remember it.
    cwd: PathBuf,
    /// Whether the child was started with --dangerously-skip-permissions.
    /// Same reason as `cwd`.
    skip_permissions: bool,
    /// Last `--effort` value used when spawning. Lets `chat_switch_model`
    /// preserve the user's effort choice unless they explicitly pick
    /// a new one in the picker.
    effort: Option<String>,
    /// Wall-clock millis (UNIX epoch) of the last traffic on this
    /// session — bumped by the reader threads on every line claude emits
    /// AND by the chat_send_* commands on every user input. Used by
    /// the live UI activity indicator, NOT by the idle reaper (see
    /// `last_user_input_ms` for why). Atomic so the reader threads can
    /// bump without taking the ChatManager mutex.
    last_activity_ms: Arc<AtomicI64>,
    /// Wall-clock millis of the last user-initiated input on this
    /// session (chat_send_user_text, chat_send_user_with_attachments,
    /// chat_send_tool_result, ChatManager::send_user_text from the
    /// scheduler). NEVER bumped by the reader threads. The idle
    /// reaper uses this to decide which sessions to kill — claude's
    /// own background chatter (replay on --resume, rate_limit_event,
    /// keepalives) doesn't keep an unused session alive.
    last_user_input_ms: Arc<AtomicI64>,
    /// True while claude is mid-turn: set by every chat_send_* command
    /// when we hand a user message to stdin, cleared by the stdout
    /// reader when it sees a `"type":"result"` line (claude's per-turn
    /// terminator). Reaper spares any session where this is true so a
    /// long-running tool call / sub-agent (>30 min) isn't killed under
    /// the user's feet while claude is actively working.
    in_flight: Arc<AtomicBool>,
}

/// Tauri-managed state. Same pattern as TerminalManager.
pub struct ChatManager {
    inner: Mutex<HashMap<String, ChatChild>>,
}

impl ChatManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Kill every spawned claude. Called from the app exit handler so
    /// children don't get re-parented to launchd and survive past the
    /// app — the user reported one such orphan from 2 days back, and
    /// the original load-avg-100+ snapshot showed 11 orphan candidates
    /// per app instance. Best-effort: we don't want app shutdown to
    /// hang on a wedged claude.
    pub fn kill_all_blocking(&self) {
        let mut map = self.inner.lock().unwrap();
        let count = map.len();
        if count == 0 {
            return;
        }
        for (term_id, mut entry) in map.drain() {
            tracing::info!(target: "deepthix::chat", %term_id, "killing on exit");
            let _ = entry.child.kill();
            // Quick wait so the child reaps cleanly; if it doesn't
            // respond fast we move on — the OS will reap on app death.
            let _ = entry.child.wait();
        }
        tracing::info!(target: "deepthix::chat", %count, "all chat children killed");
    }

    /// Kill every chat session whose **user input** is older than
    /// `timeout_ms`. Returns the number killed.
    ///
    /// Why `last_user_input_ms` and not `last_activity_ms`: the v0.4.x
    /// reaper bumped activity on every line claude wrote to stdout. A
    /// `--resume`-d session replays the entire transcript on startup
    /// (hundreds of stream-json lines in 5–30 seconds), which kept
    /// pushing `last_activity` forward. Worse, claude periodically emits
    /// rate_limit_event and system pings even when "idle", so a session
    /// where the user had walked away 10h ago still looked active to the
    /// reaper. One user accumulated 9 stale claudes (1.95 GB RAM) this
    /// way and had to reboot.
    ///
    /// Switching to "last user input" means: if YOU haven't typed in 30
    /// minutes, the session gets paused. If you're in the middle of a
    /// long tool call you can send "continue" to bump activity, or just
    /// let it timeout — the next message auto-resumes via --resume.
    ///
    /// v0.5.5: also spares sessions where `in_flight = true` so a
    /// >30-min turn (deep research, long sub-agent, long-running tool)
    /// doesn't get killed under the user's feet. The flag is cleared
    /// by the stdout reader when it sees the per-turn `result` line.
    pub fn reap_idle(&self, app: &AppHandle, timeout_ms: i64) -> usize {
        // Defensive: when the reaper is disabled (timeout_ms <= 0) the
        // background thread never spawns, but any direct caller (tests,
        // future commands) must also no-op. A stale `> timeout_ms` check
        // with timeout_ms == 0 would kill every session on the first ms.
        if timeout_ms <= 0 {
            return 0;
        }
        let now = now_ms();
        let mut map = self.inner.lock().unwrap();
        let total = map.len();
        let to_kill: Vec<String> = map
            .iter()
            .filter_map(|(term_id, entry)| {
                // Never reap a session that's mid-turn — claude is still
                // working (long tool call, sub-agent, background hook).
                // User reported sessions getting killed at 30 min even
                // while claude was actively running.
                if entry.in_flight.load(Ordering::Relaxed) {
                    return None;
                }
                let last = entry.last_user_input_ms.load(Ordering::Relaxed);
                let idle = now.saturating_sub(last);
                if idle > timeout_ms {
                    Some(term_id.clone())
                } else {
                    None
                }
            })
            .collect();
        let n = to_kill.len();
        if total > 0 {
            tracing::debug!(
                target: "deepthix::chat",
                total, will_kill = n,
                "idle reaper tick",
            );
        }
        for term_id in to_kill {
            if let Some(mut entry) = map.remove(&term_id) {
                let last = entry.last_user_input_ms.load(Ordering::Relaxed);
                let idle_ms = now.saturating_sub(last);
                let _ = entry.child.kill();
                tracing::info!(
                    target: "deepthix::chat",
                    %term_id, %idle_ms,
                    "reaped idle session (no user input in window)",
                );
                let evt = serde_json::json!({
                    "term_id": term_id,
                    "type": "exit",
                    "subtype": "idle",
                    "code": null,
                    "idle_ms": idle_ms,
                });
                let _ = app.emit("chat_exit", &evt);
            }
        }
        n
    }

    /// Send a user-text turn to a chat session by term_id. Used by
    /// the scheduler thread (it doesn't go through the Tauri command
    /// because that requires a State<'_, ...> only valid in command
    /// handler scope).
    pub fn send_user_text(&self, term_id: &str, text: &str) -> std::io::Result<()> {
        let map = self.inner.lock().unwrap();
        let entry = map
            .get(term_id)
            .ok_or_else(|| std::io::Error::other(format!("no chat session {term_id}")))?;
        // Bump both timestamps: activity for the live indicator,
        // user_input for the idle reaper. A scheduled job firing
        // through this path counts as user input — without that
        // bump the reaper would kill long-running scheduled sessions.
        let now = now_ms();
        entry.last_activity_ms.store(now, Ordering::Relaxed);
        entry.last_user_input_ms.store(now, Ordering::Relaxed);
        entry.in_flight.store(true, Ordering::Relaxed);
        let json = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": text }
        });
        let mut line = serde_json::to_string(&json)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        line.push('\n');
        let mut writer = entry.stdin.lock().unwrap();
        writer.write_all(line.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    /// Map a stable claude session UUID to the in-memory term_id. None
    /// when no chat session currently hosts that UUID.
    pub fn find_term_by_session(&self, session_id: &str) -> Option<String> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .find_map(|(term_id, child)| {
                if child.session_id.as_deref() == Some(session_id) {
                    Some(term_id.clone())
                } else {
                    None
                }
            })
    }
}

// ─── Spawn ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn chat_spawn(
    app: AppHandle,
    state: State<'_, ChatManager>,
    args: ChatSpawnArgs,
) -> Result<ChatSpawnResult, String> {
    // Cap removed per user feedback — they want session creation to be
    // transparent ("avant tu te débrouilles, je veux pas en entendre
    // parler"). The idle reaper still kills sessions inactive for 30 min
    // (DEEPTHIX_IDLE_TIMEOUT_MS) so RAM doesn't grow unbounded; the cap
    // was a belt-and-braces guard against the original zombie-children
    // bug, which the reaper now handles directly. The Settings field is
    // kept for back-compat but no longer enforced here.
    let term_id = format!("chat-{}", uuid::Uuid::new_v4().simple());
    tracing::info!(
        target: "deepthix::chat",
        %term_id, cwd = ?args.cwd, resume = ?args.resume_session_id, skip = args.skip_permissions,
        "chat_spawn",
    );

    // Re-write the on-disk overlay-settings + MCP-config files to point
    // at the CURRENTLY running app's binary path. Otherwise an old
    // claude-mcp-config.json from a previous install lingers and
    // tells claude to spawn deepthix-mcp from a path that no longer
    // exists — silent MCP startup failure.
    let _ = crate::commands::usage_snapshot::ensure_installed();

    // Resolve the claude binary the same way pty.rs does — prefer the
    // user's installed CLI on PATH, fall back to /opt/homebrew/bin.
    let claude_bin = crate::claude_bin::resolve()?;

    let mut cmd = crate::claude_bin::build_command(&claude_bin);
    cmd.current_dir(&args.cwd)
        .arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("stream-json")
        // --verbose is mandatory with --output-format=stream-json
        // (claude refuses to start otherwise).
        .arg("--verbose")
        // Token-level streaming: claude emits stream_event JSON lines
        // with content_block_delta as the assistant generates, so the
        // ChatPane can paint text incrementally instead of waiting
        // for the whole turn.
        .arg("--include-partial-messages")
        // User explicit ask (2026-05-18): every Deepthix session must
        // be able to drive the user's already-open Chrome with their
        // profiles (logged-in sessions, cookies). --chrome enables the
        // Claude-in-Chrome extension bridge (extension
        // fcoeoabgfenejglbffodgkkbkcdhcgfn talks to claude via native
        // messaging at ~/.claude/chrome/chrome-native-host). Works
        // even in stream-json mode — just exposes the
        // mcp__claude-in-chrome__* tools to the model.
        .arg("--chrome");
    if args.skip_permissions {
        cmd.arg("--dangerously-skip-permissions");
    }
    if let Some(sid) = args.resume_session_id.as_ref() {
        cmd.arg("--resume").arg(sid);
    }
    if let Some(m) = args.model.as_ref() {
        cmd.arg("--model").arg(m);
    }
    if let Some(e) = args.effort.as_ref() {
        cmd.arg("--effort").arg(e);
    }

    // Inject the deepthix-mcp sidecar so claude has access to our
    // custom tools — most importantly `deepthix__run_subtask` which
    // replaces the broken built-in Task/Agent dispatch in stream-json
    // mode (claude-code #24594/#29618). ensure_installed() above just
    // refreshed the path; passing it here makes claude actually load
    // the server.
    if let Ok(mcp) = crate::commands::usage_snapshot::mcp_config_path() {
        if mcp.exists() {
            cmd.arg("--mcp-config").arg(mcp.to_string_lossy().as_ref());
        }
    }

    // Same env-var injection pty.rs does for the legacy spawn:
    // - DEEPTHIX_DASHBOARD_PATH lets claude `Write` straight into the
    //   project's dashboard.html without the user copy/pasting a path.
    // - DEEPTHIX_PROJECT_ID is exposed for plugins / scripts that
    //   want to know which Deepthix project this claude belongs to.
    // (No DEEPTHIX_SESSION_ID at spawn time — the real UUID isn't
    // known until claude emits the system/init event later.)
    let project_id = crate::state::project_id_for_path(&args.cwd);
    if let Ok(home) = std::env::var("HOME") {
        let dashboard_path = PathBuf::from(home.clone())
            .join(".deepthix")
            .join("projects")
            .join(&project_id)
            .join("dashboard.html");
        if let Some(parent) = dashboard_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        cmd.env(
            "DEEPTHIX_DASHBOARD_PATH",
            dashboard_path.to_string_lossy().to_string(),
        );
        cmd.env("DEEPTHIX_PROJECT_ID", &project_id);
        // Workflow catalog — claude can Read/Edit/Write this JSON to
        // discover or define workflows the user can re-fire from the
        // WORKFLOW tab.
        let workflows_path = PathBuf::from(home.clone()).join(".deepthix").join("workflows.json");
        cmd.env(
            "DEEPTHIX_WORKFLOWS_PATH",
            workflows_path.to_string_lossy().to_string(),
        );
        // Shared variables — small key/value scratchpad both the user
        // (VARIABLES tab) and claude (Read/Write on the JSON) can use.
        let variables_path = PathBuf::from(home).join(".deepthix").join("variables.json");
        cmd.env(
            "DEEPTHIX_VARIABLES_PATH",
            variables_path.to_string_lossy().to_string(),
        );
    }

    // Pipe all three handles. We need stdin to send user turns and
    // stdout for the JSON event stream. stderr captures claude's own
    // warnings (rate limits, hook failures) — we forward them too.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn claude: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "claude stdin missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "claude stderr missing".to_string())?;

    // Spawn one reader thread per stream. Each thread emits a
    // chat_event per line until the pipe closes. When stdout closes,
    // we know the child exited — emit a synthetic "exit" event so the
    // webview can stop waiting.
    let last_activity_ms = Arc::new(AtomicI64::new(now_ms()));
    let last_user_input_ms = Arc::new(AtomicI64::new(now_ms()));
    let in_flight = Arc::new(AtomicBool::new(false));
    spawn_reader(
        app.clone(),
        term_id.clone(),
        stdout,
        "stdout",
        last_activity_ms.clone(),
        last_user_input_ms.clone(),
        in_flight.clone(),
    );
    spawn_reader(
        app.clone(),
        term_id.clone(),
        stderr,
        "stderr",
        last_activity_ms.clone(),
        last_user_input_ms.clone(),
        in_flight.clone(),
    );
    spawn_exit_watcher(app.clone(), term_id.clone());

    let stdin_writer: Box<dyn Write + Send> = Box::new(stdin);
    let entry = ChatChild {
        child,
        stdin: Arc::new(Mutex::new(stdin_writer)),
        session_id: args.resume_session_id.clone(),
        cwd: args.cwd.clone(),
        skip_permissions: args.skip_permissions,
        effort: args.effort.clone(),
        last_activity_ms,
        last_user_input_ms,
        in_flight,
    };
    state.inner.lock().unwrap().insert(term_id.clone(), entry);

    Ok(ChatSpawnResult {
        term_id,
        session_id: None,
    })
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    term_id: String,
    reader: R,
    stream: &'static str,
    last_activity_ms: Arc<AtomicI64>,
    last_user_input_ms: Arc<AtomicI64>,
    in_flight: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            match line {
                Ok(line) => {
                    if line.is_empty() {
                        continue;
                    }
                    // Bump first so a slow emit doesn't make the
                    // session look stale to the idle reaper.
                    last_activity_ms.store(now_ms(), Ordering::Relaxed);
                    // Detect turn end on the stdout stream. claude emits
                    // exactly one `{"type":"result",...}` line per turn
                    // (success or error). Reset the idle clock and clear
                    // the in-flight flag so the reaper can pick up an
                    // abandoned session 30 min after the turn completed.
                    //
                    // Substring match instead of full JSON parse —
                    // 100x cheaper per line and "type":"result" is
                    // unique to the result envelope.
                    if stream == "stdout" && line.contains("\"type\":\"result\"") {
                        let now = now_ms();
                        last_user_input_ms.store(now, Ordering::Relaxed);
                        in_flight.store(false, Ordering::Relaxed);
                        tracing::debug!(
                            target: "deepthix::chat",
                            %term_id,
                            "turn ended, in_flight cleared",
                        );
                    }
                    tracing::trace!(
                        target: "deepthix::chat",
                        %term_id, %stream, bytes = line.len(),
                        "chat line",
                    );
                    let evt = ChatEvent {
                        term_id: term_id.clone(),
                        line,
                        stream,
                    };
                    if let Err(e) = app.emit("chat_event", &evt) {
                        tracing::warn!(target: "deepthix::chat", error = %e, "emit failed");
                    }
                }
                Err(e) => {
                    tracing::debug!(
                        target: "deepthix::chat",
                        %term_id, %stream, error = %e,
                        "reader done",
                    );
                    break;
                }
            }
        }
    });
}

/// Background thread: every IDLE_REAPER_TICK_SECS, kill any chat session
/// whose last_activity_ms is older than IDLE_TIMEOUT_MS. Spawned once at
/// app startup. Runs until the process exits.
///
/// `timeout_ms <= 0` disables the reaper — the function returns without
/// spawning the thread. This honors the contract documented on
/// `idle_timeout_ms()` and prevents the previous infinite kill loop that
/// triggered when a stale `DEEPTHIX_IDLE_TIMEOUT_MS=0` was set.
pub fn start_idle_reaper(app: AppHandle, timeout_ms: i64) {
    if timeout_ms <= 0 {
        tracing::info!(
            target: "deepthix::chat",
            timeout_ms,
            "idle reaper disabled (timeout_ms <= 0)",
        );
        let _ = app; // keep AppHandle parameter for symmetry with the enabled branch
        return;
    }
    thread::spawn(move || {
        tracing::info!(
            target: "deepthix::chat",
            timeout_ms,
            tick_secs = IDLE_REAPER_TICK_SECS,
            "idle reaper started",
        );
        loop {
            thread::sleep(std::time::Duration::from_secs(IDLE_REAPER_TICK_SECS));
            let state = match app.try_state::<ChatManager>() {
                Some(s) => s,
                None => {
                    tracing::debug!(target: "deepthix::chat", "ChatManager gone — reaper exiting");
                    return;
                }
            };
            let killed = state.reap_idle(&app, timeout_ms);
            if killed > 0 {
                tracing::info!(
                    target: "deepthix::chat",
                    %killed,
                    "idle reaper killed sessions",
                );
            }
        }
    });
}

fn spawn_exit_watcher(app: AppHandle, term_id: String) {
    // Polls the manager once per second to detect when the child
    // exited. Cleaner than blocking on child.wait() in another thread
    // because we need to keep the Child accessible for kill().
    thread::spawn(move || {
        loop {
            thread::sleep(std::time::Duration::from_millis(1000));
            let state = match app.try_state::<ChatManager>() {
                Some(s) => s,
                None => return,
            };
            let mut map = state.inner.lock().unwrap();
            let exited = if let Some(entry) = map.get_mut(&term_id) {
                match entry.child.try_wait() {
                    Ok(Some(status)) => Some(status.code()),
                    _ => None,
                }
            } else {
                return; // already removed
            };
            if let Some(code) = exited {
                tracing::info!(
                    target: "deepthix::chat",
                    %term_id, code = ?code,
                    "child exited",
                );
                map.remove(&term_id);
                drop(map);
                let evt = serde_json::json!({
                    "term_id": term_id,
                    "type": "exit",
                    "code": code,
                });
                let _ = app.emit("chat_exit", &evt);
                return;
            }
        }
    });
}

// ─── Send / kill ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn chat_send_user_text(
    state: State<'_, ChatManager>,
    term_id: String,
    text: String,
) -> Result<(), String> {
    tracing::debug!(
        target: "deepthix::chat",
        %term_id, chars = text.chars().count(),
        "chat_send_user_text",
    );
    let json = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": text,
        }
    });
    let mut line = serde_json::to_string(&json).map_err(|e| format!("serialize: {e}"))?;
    line.push('\n');
    let map = state.inner.lock().unwrap();
    let entry = map
        .get(&term_id)
        .ok_or_else(|| format!("no chat session {term_id}"))?;
    let now = now_ms();
    entry.last_activity_ms.store(now, Ordering::Relaxed);
    entry.last_user_input_ms.store(now, Ordering::Relaxed);
    entry.in_flight.store(true, Ordering::Relaxed);
    let mut writer = entry.stdin.lock().unwrap();
    writer
        .write_all(line.as_bytes())
        .map_err(|e| format!("write stdin: {e}"))?;
    writer.flush().map_err(|e| format!("flush stdin: {e}"))?;
    Ok(())
}

/// Reply to a tool_use the assistant emitted (typically AskUserQuestion
/// — claude pauses the turn until it gets a tool_result back). Format
/// matches the SDK contract: a user message whose `content` is an array
/// containing a single tool_result block keyed by tool_use_id.
///
/// Without this command, AskUserQuestion just hangs (no UI prompt
/// before v0.3.9, no client reply ever) and claude eventually emits a
/// "Demande annulée" auto-cancellation.
#[tauri::command]
pub fn chat_send_tool_result(
    state: State<'_, ChatManager>,
    term_id: String,
    tool_use_id: String,
    content: String,
) -> Result<(), String> {
    tracing::debug!(
        target: "deepthix::chat",
        %term_id, %tool_use_id, chars = content.chars().count(),
        "chat_send_tool_result",
    );
    let json = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                }
            ]
        }
    });
    let mut line = serde_json::to_string(&json).map_err(|e| format!("serialize: {e}"))?;
    line.push('\n');
    let map = state.inner.lock().unwrap();
    let entry = map
        .get(&term_id)
        .ok_or_else(|| format!("no chat session {term_id}"))?;
    let now = now_ms();
    entry.last_activity_ms.store(now, Ordering::Relaxed);
    entry.last_user_input_ms.store(now, Ordering::Relaxed);
    entry.in_flight.store(true, Ordering::Relaxed);
    let mut writer = entry.stdin.lock().unwrap();
    writer
        .write_all(line.as_bytes())
        .map_err(|e| format!("write stdin: {e}"))?;
    writer.flush().map_err(|e| format!("flush stdin: {e}"))?;
    Ok(())
}

/// Like `chat_send_user_text` but also attaches files. Image files are
/// read, base64-encoded, and shipped as proper image content blocks so
/// claude actually sees them (sending the bare path as text — what
/// drag-drop used to do — only worked back when the SESSIONS view ran
/// the `claude` TUI in a pty and the TUI did paste-path expansion).
/// Non-image paths are appended to the text portion as plain references
/// so claude can `Read` them.
#[tauri::command]
pub fn chat_send_user_with_attachments(
    state: State<'_, ChatManager>,
    term_id: String,
    text: String,
    paths: Vec<String>,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    fn media_type_for(path: &str) -> Option<&'static str> {
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match ext.as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            _ => None,
        }
    }

    let mut blocks: Vec<serde_json::Value> = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();
    if !text.is_empty() {
        text_parts.push(text.clone());
    }

    let mut image_count = 0usize;
    let mut other_count = 0usize;
    for path in &paths {
        if let Some(media_type) = media_type_for(path) {
            let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
            let b64 = STANDARD.encode(&bytes);
            blocks.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": b64,
                }
            }));
            image_count += 1;
        } else {
            // Non-image: keep the path in the text portion so claude
            // can decide to Read it.
            text_parts.push(path.clone());
            other_count += 1;
        }
    }

    let combined_text = text_parts.join("\n");
    if !combined_text.is_empty() {
        // Put text FIRST so claude sees the prompt, then the images.
        blocks.insert(
            0,
            serde_json::json!({
                "type": "text",
                "text": combined_text,
            }),
        );
    }

    if blocks.is_empty() {
        return Err("nothing to send (empty text + no attachments)".to_string());
    }

    let json = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": blocks,
        }
    });
    let mut line = serde_json::to_string(&json).map_err(|e| format!("serialize: {e}"))?;
    line.push('\n');

    tracing::info!(
        target: "deepthix::chat",
        %term_id,
        text_chars = combined_text.chars().count(),
        image_count,
        other_count,
        line_bytes = line.len(),
        "chat_send_user_with_attachments",
    );

    let map = state.inner.lock().unwrap();
    let entry = map
        .get(&term_id)
        .ok_or_else(|| format!("no chat session {term_id}"))?;
    let now = now_ms();
    entry.last_activity_ms.store(now, Ordering::Relaxed);
    entry.last_user_input_ms.store(now, Ordering::Relaxed);
    entry.in_flight.store(true, Ordering::Relaxed);
    let mut writer = entry.stdin.lock().unwrap();
    writer
        .write_all(line.as_bytes())
        .map_err(|e| format!("write stdin: {e}"))?;
    writer.flush().map_err(|e| format!("flush stdin: {e}"))?;
    Ok(())
}

/// Send SIGINT to the underlying claude process so it stops the
/// current turn without losing the conversation. Mirrors the Ctrl+C
/// the user would press in a TTY. The child usually exits — our
/// exit_watcher picks that up and the webview can decide whether to
/// auto-respawn with --resume.
#[tauri::command]
pub fn chat_interrupt(state: State<'_, ChatManager>, term_id: String) -> Result<(), String> {
    tracing::info!(target: "deepthix::chat", %term_id, "chat_interrupt");
    let map = state.inner.lock().unwrap();
    let entry = map
        .get(&term_id)
        .ok_or_else(|| format!("no chat session {term_id}"))?;
    let pid = entry.child.id();
    drop(map);
    // SIGINT on Unix; Windows has no equivalent for non-attached console
    // children, so we fall through to TerminateProcess (the caller's
    // immediate child.kill() if any). The Stop button uses
    // chat_interrupt_and_resume which always pairs with kill().
    #[cfg(unix)]
    {
        let status = Command::new("/bin/kill")
            .arg("-INT")
            .arg(pid.to_string())
            .status()
            .map_err(|e| format!("kill spawn: {e}"))?;
        if !status.success() {
            return Err(format!("kill -INT exited {status}"));
        }
    }
    #[cfg(windows)]
    {
        let _ = pid;
        return Err("interrupt is unix-only on this build; use chat_interrupt_and_resume".to_string());
    }
    #[allow(unreachable_code)]
    Ok(())
}

/// Stop the current turn AND immediately respawn under the same term_id
/// with `--resume <session_id>` so the conversation continues without
/// the user having to recreate the session.
///
/// In `--print --input-format stream-json` mode claude has no concept of
/// "abort the current turn but keep the readline alive" — SIGINT just
/// makes the process exit. So when the user clicks Stop they don't want
/// the session killed, just the active work; this command restores the
/// "stop turn" semantic by re-spawning right after the kill.
#[tauri::command]
pub fn chat_interrupt_and_resume(
    app: AppHandle,
    state: State<'_, ChatManager>,
    term_id: String,
    model: Option<String>,
) -> Result<(), String> {
    tracing::info!(
        target: "deepthix::chat",
        %term_id, ?model,
        "chat_interrupt_and_resume",
    );

    // Snapshot what we need to respawn under the lock, then release.
    let (cwd, session_id, skip_permissions, prev_effort) = {
        let map = state.inner.lock().unwrap();
        let entry = map
            .get(&term_id)
            .ok_or_else(|| format!("no chat session {term_id}"))?;
        let sid = entry.session_id.clone().ok_or_else(|| {
            "session has no UUID yet — can't safely interrupt+resume before init".to_string()
        })?;
        (
            entry.cwd.clone(),
            sid,
            entry.skip_permissions,
            entry.effort.clone(),
        )
    };

    // SIGINT first to give claude a chance to flush partial state,
    // then settle briefly + remove + hard-kill to be sure. Windows has
    // no SIGINT for non-console children, so we skip straight to the
    // hard kill below — that path still gives us "stop turn + resume"
    // behavior, just without the graceful flush.
    #[cfg(unix)]
    if let Some(entry) = state.inner.lock().unwrap().get(&term_id) {
        let pid = entry.child.id();
        let _ = Command::new("/bin/kill")
            .arg("-INT")
            .arg(pid.to_string())
            .status();
    }
    std::thread::sleep(std::time::Duration::from_millis(150));
    if let Some(mut prev) = state.inner.lock().unwrap().remove(&term_id) {
        let _ = prev.child.kill();
    }

    // Respawn — same skeleton as chat_switch_model but model is
    // optional (preserve current; FE passes its currentModel).
    let claude_bin = crate::claude_bin::resolve()?;
    let mut cmd = crate::claude_bin::build_command(&claude_bin);
    cmd.current_dir(&cwd)
        .arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        // User explicit ask (2026-05-18): every Deepthix session must
        // be able to drive the user's already-open Chrome with their
        // profiles (logged-in sessions, cookies). --chrome enables the
        // Claude-in-Chrome extension bridge (extension
        // fcoeoabgfenejglbffodgkkbkcdhcgfn talks to claude via native
        // messaging at ~/.claude/chrome/chrome-native-host). Works
        // even in stream-json mode — just exposes the
        // mcp__claude-in-chrome__* tools to the model.
        .arg("--chrome")
        .arg("--resume")
        .arg(&session_id);
    if let Some(m) = model.as_ref() {
        cmd.arg("--model").arg(m);
    }
    if let Some(e) = prev_effort.as_ref() {
        cmd.arg("--effort").arg(e);
    }
    if skip_permissions {
        cmd.arg("--dangerously-skip-permissions");
    }
    let project_id = crate::state::project_id_for_path(&cwd);
    if let Ok(home) = std::env::var("HOME") {
        let dashboard_path = PathBuf::from(home.clone())
            .join(".deepthix")
            .join("projects")
            .join(&project_id)
            .join("dashboard.html");
        if let Some(parent) = dashboard_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        cmd.env(
            "DEEPTHIX_DASHBOARD_PATH",
            dashboard_path.to_string_lossy().to_string(),
        );
        cmd.env("DEEPTHIX_PROJECT_ID", &project_id);
        let workflows_path = PathBuf::from(home.clone()).join(".deepthix").join("workflows.json");
        cmd.env(
            "DEEPTHIX_WORKFLOWS_PATH",
            workflows_path.to_string_lossy().to_string(),
        );
        let variables_path = PathBuf::from(home).join(".deepthix").join("variables.json");
        cmd.env(
            "DEEPTHIX_VARIABLES_PATH",
            variables_path.to_string_lossy().to_string(),
        );
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("respawn after interrupt: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "claude stdin missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "claude stderr missing".to_string())?;

    let last_activity_ms = Arc::new(AtomicI64::new(now_ms()));
    let last_user_input_ms = Arc::new(AtomicI64::new(now_ms()));
    let in_flight = Arc::new(AtomicBool::new(false));
    spawn_reader(
        app.clone(),
        term_id.clone(),
        stdout,
        "stdout",
        last_activity_ms.clone(),
        last_user_input_ms.clone(),
        in_flight.clone(),
    );
    spawn_reader(
        app.clone(),
        term_id.clone(),
        stderr,
        "stderr",
        last_activity_ms.clone(),
        last_user_input_ms.clone(),
        in_flight.clone(),
    );
    spawn_exit_watcher(app.clone(), term_id.clone());

    let stdin_writer: Box<dyn Write + Send> = Box::new(stdin);
    let entry = ChatChild {
        child,
        stdin: Arc::new(Mutex::new(stdin_writer)),
        session_id: Some(session_id),
        cwd,
        skip_permissions,
        effort: prev_effort,
        last_activity_ms,
        last_user_input_ms,
        in_flight,
    };
    state.inner.lock().unwrap().insert(term_id, entry);
    Ok(())
}

/// Soft-restart a chat session with a different model.
///
/// The same `term_id` is reused so the webview's existing event
/// subscription stays attached — only the underlying claude child is
/// swapped out for a fresh `--resume <session_id> --model <new>`
/// invocation. The conversation history is preserved (claude resumes
/// from the same JSONL); the user just sees a brief "switching model…"
/// system message followed by the new model picking up the next turn.
/// `effort` semantics: None = preserve the existing one. Some("") =
/// clear (let claude pick its default for the model). Some("<level>")
/// = use that level (low | medium | high | xhigh | max).
#[tauri::command]
pub fn chat_switch_model(
    app: AppHandle,
    state: State<'_, ChatManager>,
    term_id: String,
    model: String,
    effort: Option<String>,
) -> Result<(), String> {
    tracing::info!(target: "deepthix::chat", %term_id, %model, ?effort, "chat_switch_model");
    // Snapshot what we need to respawn under the lock, then release
    // before doing the heavy work.
    let (cwd, session_id, skip_permissions, prev_effort) = {
        let map = state.inner.lock().unwrap();
        let entry = map
            .get(&term_id)
            .ok_or_else(|| format!("no chat session {term_id}"))?;
        let sid = entry
            .session_id
            .clone()
            .ok_or_else(|| "session has no UUID yet — wait for init before switching".to_string())?;
        (
            entry.cwd.clone(),
            sid,
            entry.skip_permissions,
            entry.effort.clone(),
        )
    };
    // Resolve effort: explicit Some("") clears, None preserves prev,
    // Some("<level>") replaces.
    let next_effort = match effort {
        Some(s) if s.is_empty() => None,
        Some(s) => Some(s),
        None => prev_effort,
    };

    // Kill the current child + remove it. The exit_watcher will pick
    // up the kill, emit chat_exit, and remove the map entry — but to
    // avoid a race with our re-insert below, we remove + drop here.
    if let Some(mut prev) = state.inner.lock().unwrap().remove(&term_id) {
        let _ = prev.child.kill();
    }

    // Re-spawn with the new model, --resume on the same session_id.
    let claude_bin = crate::claude_bin::resolve()?;
    let mut cmd = crate::claude_bin::build_command(&claude_bin);
    cmd.current_dir(&cwd)
        .arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        // User explicit ask (2026-05-18): every Deepthix session must
        // be able to drive the user's already-open Chrome with their
        // profiles (logged-in sessions, cookies). --chrome enables the
        // Claude-in-Chrome extension bridge (extension
        // fcoeoabgfenejglbffodgkkbkcdhcgfn talks to claude via native
        // messaging at ~/.claude/chrome/chrome-native-host). Works
        // even in stream-json mode — just exposes the
        // mcp__claude-in-chrome__* tools to the model.
        .arg("--chrome")
        .arg("--resume")
        .arg(&session_id)
        .arg("--model")
        .arg(&model);
    if let Some(e) = next_effort.as_ref() {
        cmd.arg("--effort").arg(e);
    }
    if skip_permissions {
        cmd.arg("--dangerously-skip-permissions");
    }
    // Same env-var injection as chat_spawn — DEEPTHIX_DASHBOARD_PATH
    // etc. so the new child sees the project context.
    let project_id = crate::state::project_id_for_path(&cwd);
    if let Ok(home) = std::env::var("HOME") {
        let dashboard_path = PathBuf::from(home.clone())
            .join(".deepthix")
            .join("projects")
            .join(&project_id)
            .join("dashboard.html");
        if let Some(parent) = dashboard_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        cmd.env(
            "DEEPTHIX_DASHBOARD_PATH",
            dashboard_path.to_string_lossy().to_string(),
        );
        cmd.env("DEEPTHIX_PROJECT_ID", &project_id);
        let workflows_path = PathBuf::from(home.clone()).join(".deepthix").join("workflows.json");
        cmd.env(
            "DEEPTHIX_WORKFLOWS_PATH",
            workflows_path.to_string_lossy().to_string(),
        );
        let variables_path = PathBuf::from(home).join(".deepthix").join("variables.json");
        cmd.env(
            "DEEPTHIX_VARIABLES_PATH",
            variables_path.to_string_lossy().to_string(),
        );
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("respawn claude: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "claude stdin missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "claude stderr missing".to_string())?;

    let last_activity_ms = Arc::new(AtomicI64::new(now_ms()));
    let last_user_input_ms = Arc::new(AtomicI64::new(now_ms()));
    let in_flight = Arc::new(AtomicBool::new(false));
    spawn_reader(
        app.clone(),
        term_id.clone(),
        stdout,
        "stdout",
        last_activity_ms.clone(),
        last_user_input_ms.clone(),
        in_flight.clone(),
    );
    spawn_reader(
        app.clone(),
        term_id.clone(),
        stderr,
        "stderr",
        last_activity_ms.clone(),
        last_user_input_ms.clone(),
        in_flight.clone(),
    );
    spawn_exit_watcher(app.clone(), term_id.clone());

    let stdin_writer: Box<dyn Write + Send> = Box::new(stdin);
    let entry = ChatChild {
        child,
        stdin: Arc::new(Mutex::new(stdin_writer)),
        session_id: Some(session_id),
        cwd,
        skip_permissions,
        effort: next_effort,
        last_activity_ms,
        last_user_input_ms,
        in_flight,
    };
    state.inner.lock().unwrap().insert(term_id, entry);
    Ok(())
}

/// Webview tells us the claude session UUID it just learned from the
/// `system/init` event. We store it so the scheduler can resolve a
/// stable session_id back to the live term_id.
#[tauri::command]
pub fn chat_set_session_id(
    state: State<'_, ChatManager>,
    term_id: String,
    session_id: String,
) -> Result<(), String> {
    let mut map = state.inner.lock().unwrap();
    if let Some(entry) = map.get_mut(&term_id) {
        entry.session_id = Some(session_id.clone());
        tracing::debug!(target: "deepthix::chat", %term_id, %session_id, "session id registered");
        Ok(())
    } else {
        Err(format!("no chat session {term_id}"))
    }
}

/// Read every JSONL line of a past claude session so the ChatPane can
/// render the history before the new stream-json child is even spawned.
/// Returns the lines verbatim (no Rust-side parsing) — the webview
/// already has the JSON-shape knowledge to turn each record into a
/// Message bubble.
///
/// `project_cwd` + `session_id` are the same pair we use everywhere
/// else; they resolve to ~/.claude/projects/<hash>/<session_id>.jsonl
/// where hash = absolute project path with slashes/backslashes/colons
/// replaced by dashes.
#[tauri::command]
pub fn chat_load_history(project_cwd: PathBuf, session_id: String) -> Result<Vec<String>, String> {
    let path = crate::jsonl_watcher::predict_jsonl_path(&project_cwd, &session_id);
    tracing::debug!(target: "deepthix::chat", ?path, %session_id, "chat_load_history");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        // Treat ANY filesystem error as "no history" rather than
        // propagating to the UI: the worst case (history not shown)
        // beats a red banner that tells the user nothing actionable.
        // The full path + error is still logged for debugging.
        Err(e) => {
            tracing::warn!(
                target: "deepthix::chat",
                ?path, error = %e, kind = ?e.kind(),
                "chat_load_history failed — returning empty",
            );
            return Ok(vec![]);
        }
    };
    // Cap to the last HISTORY_TAIL_LINES non-empty lines. A long-running
    // session's JSONL can reach 8-10 MB (thousands of records); shipping
    // all of them over IPC and parsing each into a Message bubble froze
    // the UI for tens of seconds on project switch. The webview only
    // keeps the last ~100 messages in state anyway (messagesCap), so
    // anything beyond a few hundred trailing lines is invisible work.
    const HISTORY_TAIL_LINES: usize = 600;
    let all: Vec<&str> = raw.lines().filter(|l| !l.is_empty()).collect();
    let start = all.len().saturating_sub(HISTORY_TAIL_LINES);
    Ok(all[start..].iter().map(|s| s.to_string()).collect())
}

/// Format the last `last_n` user/assistant turns of a session into a
/// human-readable excerpt. Used by the Coach pane to brief its own
/// claude session on what the main session has been doing without
/// dumping the raw JSONL on it.
///
/// Skips queue-operation, attachment (hook output), and system noise.
/// Tool_use blocks are summarised inline so the coach sees what was
/// invoked without the full input dump.
#[tauri::command]
pub fn read_session_excerpt(
    project_cwd: PathBuf,
    session_id: String,
    last_n: Option<usize>,
) -> Result<String, String> {
    let limit = last_n.unwrap_or(20).min(200);
    let path = crate::jsonl_watcher::predict_jsonl_path(&project_cwd, &session_id);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        // Same policy as chat_load_history: prefer empty excerpt over
        // a UI banner. The CoachPane polls this on a timer, so a
        // transient FS error must not stick a red error in the user's
        // face on every refresh.
        Err(e) => {
            tracing::warn!(
                target: "deepthix::chat",
                ?path, error = %e, kind = ?e.kind(),
                "read_session_excerpt failed — returning empty",
            );
            return Ok(String::new());
        }
    };
    // Walk from the end, collect up to `limit` user/assistant records,
    // then reverse so the excerpt reads forward.
    let mut entries: Vec<String> = Vec::new();
    for line in raw.lines().rev() {
        if entries.len() >= limit {
            break;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match kind {
            "user" => {
                let content = v.get("message").and_then(|m| m.get("content"));
                let body = match content {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Array(a)) => {
                        let mut buf = String::new();
                        for b in a {
                            let bt = b.get("type").and_then(|x| x.as_str()).unwrap_or("");
                            if bt == "text" {
                                if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                                    buf.push_str(t);
                                    buf.push('\n');
                                }
                            } else if bt == "tool_result" {
                                let txt = b.get("content").map(stringify_short).unwrap_or_default();
                                buf.push_str(&format!("[tool_result] {}\n", short(&txt, 240)));
                            }
                        }
                        buf
                    }
                    _ => continue,
                };
                let trimmed = short(body.trim(), 600);
                entries.push(format!("USER:\n{trimmed}\n"));
            }
            "assistant" => {
                let content = v.get("message").and_then(|m| m.get("content"));
                let mut buf = String::new();
                if let Some(serde_json::Value::Array(blocks)) = content {
                    for b in blocks {
                        let bt = b.get("type").and_then(|x| x.as_str()).unwrap_or("");
                        if bt == "text" {
                            if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                                buf.push_str(t);
                                buf.push('\n');
                            }
                        } else if bt == "tool_use" {
                            let name = b.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                            let input = b.get("input").map(stringify_short).unwrap_or_default();
                            buf.push_str(&format!("[tool: {name}] {}\n", short(&input, 240)));
                        }
                    }
                }
                let trimmed = short(buf.trim(), 800);
                if !trimmed.is_empty() {
                    entries.push(format!("ASSISTANT:\n{trimmed}\n"));
                }
            }
            _ => continue,
        }
    }
    entries.reverse();
    Ok(entries.join("\n---\n\n"))
}

fn stringify_short(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        _ => serde_json::to_string(v).unwrap_or_default(),
    }
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{truncated}…")
}

// ─── Coach state (per-project on/off + persistent session id) ──────────

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct CoachState {
    /// Whether the coach is currently ON for this project. When true,
    /// the webview keeps a 10-minute interval going and feeds the
    /// coach excerpts of recent activity.
    #[serde(default)]
    pub enabled: bool,
    /// Persistent claude session UUID for the coach. Saved once the
    /// system/init event reveals it, so re-opening the project resumes
    /// the same coach instead of spawning a fresh one each time.
    #[serde(default)]
    pub coach_session_id: Option<String>,
    /// Last analysis tick (epoch ms). Used by the webview to decide
    /// whether to fire the next tick immediately on launch (if it's
    /// been > interval since the last one) or wait the full interval.
    #[serde(default)]
    pub last_run_ms: u64,
}

fn coach_state_path(project_id: &str) -> std::io::Result<PathBuf> {
    Ok(crate::storage::project_dir(project_id)?.join("coach.json"))
}

#[tauri::command]
pub fn read_project_coach_state(project_id: String) -> Result<CoachState, String> {
    let path = coach_state_path(&project_id).map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(CoachState::default()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn write_project_coach_state(
    project_id: String,
    state: CoachState,
) -> Result<(), String> {
    let path = coach_state_path(&project_id).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

fn coach_messages_path(project_id: &str) -> std::io::Result<PathBuf> {
    Ok(crate::storage::project_dir(project_id)?.join("coach-messages.json"))
}

/// Path to the global (cross-project) coach workspace. The coach
/// session is spawned in this directory so it has a stable cwd that
/// doesn't change with project switches. Created on demand.
fn coach_workspace_dir() -> std::io::Result<PathBuf> {
    let dir = crate::storage::deepthix_dir()?.join("coach-workspace");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub fn coach_workspace_path() -> Result<String, String> {
    let dir = coach_workspace_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

fn global_coach_state_path() -> std::io::Result<PathBuf> {
    Ok(crate::storage::deepthix_dir()?.join("coach.json"))
}

fn global_coach_messages_path() -> std::io::Result<PathBuf> {
    Ok(crate::storage::deepthix_dir()?.join("coach-messages.json"))
}

/// Read the GLOBAL coach state (toggle ON/OFF + coach session UUID).
/// Replaces the per-project read for the new "one coach for the whole
/// app" model — flipping ON in one project means ON for every project.
#[tauri::command]
pub fn read_global_coach_state() -> Result<CoachState, String> {
    let path = global_coach_state_path().map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(CoachState::default()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn write_global_coach_state(state: CoachState) -> Result<(), String> {
    let path = global_coach_state_path().map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn read_global_coach_messages() -> Result<String, String> {
    let path = global_coach_messages_path().map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn write_global_coach_messages(body: String) -> Result<(), String> {
    let path = global_coach_messages_path().map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn read_project_coach_messages(project_id: String) -> Result<String, String> {
    let path = coach_messages_path(&project_id).map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn write_project_coach_messages(
    project_id: String,
    body: String,
) -> Result<(), String> {
    let path = coach_messages_path(&project_id).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Append a coach-suggested note to the project's `CLAUDE.md`. Used
/// by the Coach pane's "Add to memory" button so insights persist
/// into the main session's context on next launch.
///
/// Wraps the addition in a clearly-marked section so re-runs don't
/// step on each other.
#[tauri::command]
pub fn append_to_claude_md(project_cwd: PathBuf, text: String) -> Result<(), String> {
    let path = project_cwd.join("CLAUDE.md");
    let block = format!(
        "\n\n<!-- coach: {} -->\n{}\n",
        chrono::Utc::now().format("%Y-%m-%d %H:%M UTC"),
        text.trim(),
    );
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open: {e}"))?;
    f.write_all(block.as_bytes()).map_err(|e| format!("write: {e}"))?;
    tracing::info!(target: "deepthix::chat", ?path, bytes = block.len(), "append_to_claude_md");
    Ok(())
}

/// Soft-restart a chat session against a DIFFERENT session_id —
/// used by /resume to switch the bound term_id from the current
/// conversation to one the user picked. Same kill+respawn pattern
/// as chat_switch_model but the model + effort are preserved and the
/// session_id is replaced. The webview's event subscription stays
/// attached because the term_id doesn't change.
#[tauri::command]
pub fn chat_resume_other_session(
    app: AppHandle,
    state: State<'_, ChatManager>,
    term_id: String,
    session_id: String,
    model: Option<String>,
) -> Result<(), String> {
    tracing::info!(
        target: "deepthix::chat",
        %term_id, new_session = %session_id, ?model,
        "chat_resume_other_session"
    );

    let (cwd, skip_permissions, prev_effort) = {
        let map = state.inner.lock().unwrap();
        let entry = map
            .get(&term_id)
            .ok_or_else(|| format!("no chat session {term_id}"))?;
        (
            entry.cwd.clone(),
            entry.skip_permissions,
            entry.effort.clone(),
        )
    };

    // Kill the current child + remove the entry. The exit_watcher will
    // see it gone and bail.
    if let Some(mut prev) = state.inner.lock().unwrap().remove(&term_id) {
        let _ = prev.child.kill();
    }

    let claude_bin = crate::claude_bin::resolve()?;
    let mut cmd = crate::claude_bin::build_command(&claude_bin);
    cmd.current_dir(&cwd)
        .arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        // User explicit ask (2026-05-18): every Deepthix session must
        // be able to drive the user's already-open Chrome with their
        // profiles (logged-in sessions, cookies). --chrome enables the
        // Claude-in-Chrome extension bridge (extension
        // fcoeoabgfenejglbffodgkkbkcdhcgfn talks to claude via native
        // messaging at ~/.claude/chrome/chrome-native-host). Works
        // even in stream-json mode — just exposes the
        // mcp__claude-in-chrome__* tools to the model.
        .arg("--chrome")
        .arg("--resume")
        .arg(&session_id);
    if let Some(m) = model.as_ref() {
        cmd.arg("--model").arg(m);
    }
    if let Some(e) = prev_effort.as_ref() {
        cmd.arg("--effort").arg(e);
    }
    if skip_permissions {
        cmd.arg("--dangerously-skip-permissions");
    }
    let project_id = crate::state::project_id_for_path(&cwd);
    if let Ok(home) = std::env::var("HOME") {
        let dashboard_path = PathBuf::from(home.clone())
            .join(".deepthix")
            .join("projects")
            .join(&project_id)
            .join("dashboard.html");
        if let Some(parent) = dashboard_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        cmd.env(
            "DEEPTHIX_DASHBOARD_PATH",
            dashboard_path.to_string_lossy().to_string(),
        );
        cmd.env("DEEPTHIX_PROJECT_ID", &project_id);
        let workflows_path = PathBuf::from(home.clone()).join(".deepthix").join("workflows.json");
        cmd.env(
            "DEEPTHIX_WORKFLOWS_PATH",
            workflows_path.to_string_lossy().to_string(),
        );
        let variables_path = PathBuf::from(home).join(".deepthix").join("variables.json");
        cmd.env(
            "DEEPTHIX_VARIABLES_PATH",
            variables_path.to_string_lossy().to_string(),
        );
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("respawn for resume: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "claude stdin missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "claude stderr missing".to_string())?;

    let last_activity_ms = Arc::new(AtomicI64::new(now_ms()));
    let last_user_input_ms = Arc::new(AtomicI64::new(now_ms()));
    let in_flight = Arc::new(AtomicBool::new(false));
    spawn_reader(
        app.clone(),
        term_id.clone(),
        stdout,
        "stdout",
        last_activity_ms.clone(),
        last_user_input_ms.clone(),
        in_flight.clone(),
    );
    spawn_reader(
        app.clone(),
        term_id.clone(),
        stderr,
        "stderr",
        last_activity_ms.clone(),
        last_user_input_ms.clone(),
        in_flight.clone(),
    );
    spawn_exit_watcher(app.clone(), term_id.clone());

    let stdin_writer: Box<dyn Write + Send> = Box::new(stdin);
    let entry = ChatChild {
        child,
        stdin: Arc::new(Mutex::new(stdin_writer)),
        session_id: Some(session_id),
        cwd,
        skip_permissions,
        effort: prev_effort,
        last_activity_ms,
        last_user_input_ms,
        in_flight,
    };
    state.inner.lock().unwrap().insert(term_id, entry);
    Ok(())
}

// ─── Resume / rewind ────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ResumableSession {
    pub session_id: String,
    pub jsonl_path: String,
    pub modified_ms: u64,
    pub size_bytes: u64,
    /// First user message (truncated to ~200 chars) — preview shown in
    /// the picker so the user can identify the session.
    pub first_user_text: String,
    /// Total user-record count in the JSONL — useful as a "how long
    /// is this conversation" signal in the picker.
    pub user_turn_count: u32,
}

/// List every resumable claude session for the given project cwd.
/// Reads `~/.claude/projects/<hash>/*.jsonl` and gathers metadata.
/// Sorted by mtime desc (most recent first).
#[tauri::command]
pub fn list_resumable_sessions(project_cwd: PathBuf) -> Result<Vec<ResumableSession>, String> {
    let raw = project_cwd.to_string_lossy();
    let hash: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '.' => '-',
            other => other,
        })
        .collect();
    let dir = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("projects").join(&hash),
        None => return Err("no home dir".to_string()),
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read dir: {e}")),
    };
    let mut out: Vec<ResumableSession> = Vec::new();
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let size_bytes = meta.len();
        // Read the file to extract the first user text + count user
        // records. For very large transcripts (>2MB) we cap to avoid
        // blocking the UI; the count then becomes a lower bound but
        // the preview is still accurate.
        const PREVIEW_CAP_BYTES: u64 = 2 * 1024 * 1024;
        let body = if size_bytes <= PREVIEW_CAP_BYTES {
            std::fs::read_to_string(&path).unwrap_or_default()
        } else {
            // Read just the head — enough for the first user message.
            let mut buf = vec![0u8; 16 * 1024];
            use std::io::Read;
            let mut f = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let n = f.read(&mut buf).unwrap_or(0);
            buf.truncate(n);
            String::from_utf8_lossy(&buf).into_owned()
        };
        let mut first_user = String::new();
        let mut user_count: u32 = 0;
        for line in body.lines() {
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("user") {
                continue;
            }
            let content = v.get("message").and_then(|m| m.get("content"));
            let text = match content {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Array(a)) => {
                    let mut buf = String::new();
                    for b in a {
                        if b.get("type").and_then(|x| x.as_str()) == Some("text") {
                            if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                                buf.push_str(t);
                            }
                        }
                    }
                    buf
                }
                _ => continue,
            };
            if text.trim().is_empty() {
                continue;
            }
            user_count += 1;
            if first_user.is_empty() {
                first_user = short(text.trim(), 200);
            }
        }
        out.push(ResumableSession {
            session_id,
            jsonl_path: path.to_string_lossy().into_owned(),
            modified_ms,
            size_bytes,
            first_user_text: first_user,
            user_turn_count: user_count,
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

/// Truncate the active session's JSONL by removing the LAST `n` user
/// turns plus everything after each. Result: claude `--resume` on the
/// returned session_id resumes from before those turns happened.
///
/// Returns the new line count of the JSONL.
#[tauri::command]
pub fn rewind_session(
    project_cwd: PathBuf,
    session_id: String,
    n: u32,
) -> Result<u32, String> {
    let n_drop = n.max(1);
    let path = crate::jsonl_watcher::predict_jsonl_path(&project_cwd, &session_id);
    // rewind_session is user-initiated (the /rewind command) and the
    // user genuinely needs to see WHY we couldn't read the JSONL —
    // returning empty here would silently no-op a destructive intent.
    // Include the path in the error so a Windows os error 123 is
    // diagnosable without instrumentation.
    let body = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "read jsonl {} ({:?}): {}",
            path.display(),
            e.kind(),
            e
        )
    })?;
    let lines: Vec<&str> = body.lines().collect();

    // Walk forward, mark indexes of every user record. Cut at the index
    // that puts us BEFORE the Nth-from-last user turn.
    let mut user_idxs: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("user") {
            // Only count "real" user messages (not tool_result-only).
            let content = v.get("message").and_then(|m| m.get("content"));
            let has_text = match content {
                Some(serde_json::Value::String(s)) => !s.trim().is_empty(),
                Some(serde_json::Value::Array(arr)) => arr
                    .iter()
                    .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")),
                _ => false,
            };
            if has_text {
                user_idxs.push(i);
            }
        }
    }
    if user_idxs.is_empty() {
        return Err("no user turns to rewind".to_string());
    }
    if (n_drop as usize) > user_idxs.len() {
        return Err(format!(
            "asked to rewind {n_drop}, but only {} user turns exist",
            user_idxs.len()
        ));
    }
    let cut_at = user_idxs[user_idxs.len() - n_drop as usize];
    let kept: Vec<&str> = lines.into_iter().take(cut_at).collect();
    let mut new_body = kept.join("\n");
    if !new_body.is_empty() {
        new_body.push('\n');
    }

    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, new_body.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    let new_count = kept.len() as u32;
    tracing::info!(
        target: "deepthix::chat",
        %session_id, %n_drop, %new_count,
        "rewind_session"
    );
    Ok(new_count)
}

/// Fork a session at a specific message uuid. Writes a NEW JSONL file
/// containing every record BEFORE the fork point (the message itself
/// and everything after is dropped), with `sessionId` rewritten to the
/// new uuid. Returns the new session uuid so the caller can spawn a
/// fresh `chat --resume <new>` from it.
///
/// Non-destructive: the original transcript is untouched, so the user
/// can fork multiple times from different points without losing
/// history. Counterpart to `/rewind N` which is destructive in-place.
///
/// The fork target is identified by the per-record `uuid` field in
/// the JSONL (each user/assistant/attachment record has one). The
/// frontend exposes this as a "↶ rewind here" button on past user
/// bubbles — clicking forks, kills the current chat term, and spawns
/// a new one resuming the forked transcript.
#[tauri::command]
pub fn chat_fork_at_uuid(
    project_cwd: PathBuf,
    session_id: String,
    fork_at_uuid: String,
) -> Result<String, String> {
    let src = crate::jsonl_watcher::predict_jsonl_path(&project_cwd, &session_id);
    let body = std::fs::read_to_string(&src).map_err(|e| format!("read jsonl: {e}"))?;
    let new_uuid = uuid::Uuid::new_v4().to_string();
    let mut kept: Vec<String> = Vec::new();
    let mut found = false;
    for line in body.lines() {
        let mut v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                // Keep unparseable lines verbatim — better than silently
                // dropping a record we don't understand.
                kept.push(line.to_string());
                continue;
            }
        };
        if v.get("uuid").and_then(|u| u.as_str()) == Some(fork_at_uuid.as_str()) {
            found = true;
            break;
        }
        if let Some(obj) = v.as_object_mut() {
            obj.insert(
                "sessionId".to_string(),
                serde_json::Value::String(new_uuid.clone()),
            );
        }
        kept.push(v.to_string());
    }
    if !found {
        return Err(format!("uuid {fork_at_uuid} not found in transcript"));
    }
    let dst = src.with_file_name(format!("{new_uuid}.jsonl"));
    let mut new_body = kept.join("\n");
    if !new_body.is_empty() {
        new_body.push('\n');
    }
    std::fs::write(&dst, new_body.as_bytes()).map_err(|e| format!("write jsonl: {e}"))?;
    tracing::info!(
        target: "deepthix::chat",
        %session_id, %new_uuid, %fork_at_uuid,
        kept_lines = kept.len(),
        dst = %dst.display(),
        "chat_fork_at_uuid",
    );
    Ok(new_uuid)
}

#[tauri::command]
pub fn chat_kill(state: State<'_, ChatManager>, term_id: String) -> Result<(), String> {
    tracing::info!(target: "deepthix::chat", %term_id, "chat_kill");
    let mut map = state.inner.lock().unwrap();
    if let Some(mut entry) = map.remove(&term_id) {
        // Best-effort; the exit watcher will pick up the actual code.
        let _ = entry.child.kill();
    }
    Ok(())
}
