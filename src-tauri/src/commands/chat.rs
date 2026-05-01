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
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

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

    /// Send a user-text turn to a chat session by term_id. Used by
    /// the scheduler thread (it doesn't go through the Tauri command
    /// because that requires a State<'_, ...> only valid in command
    /// handler scope).
    pub fn send_user_text(&self, term_id: &str, text: &str) -> std::io::Result<()> {
        let map = self.inner.lock().unwrap();
        let entry = map
            .get(term_id)
            .ok_or_else(|| std::io::Error::other(format!("no chat session {term_id}")))?;
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
    let term_id = format!("chat-{}", uuid::Uuid::new_v4().simple());
    tracing::info!(
        target: "deepthix::chat",
        %term_id, cwd = ?args.cwd, resume = ?args.resume_session_id, skip = args.skip_permissions,
        "chat_spawn",
    );

    // Resolve the claude binary the same way pty.rs does — prefer the
    // user's installed CLI on PATH, fall back to /opt/homebrew/bin.
    let claude_bin = which_claude()?;

    let mut cmd = Command::new(&claude_bin);
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
        .arg("--include-partial-messages");
    if args.skip_permissions {
        cmd.arg("--dangerously-skip-permissions");
    }
    if let Some(sid) = args.resume_session_id.as_ref() {
        cmd.arg("--resume").arg(sid);
    }
    if let Some(m) = args.model.as_ref() {
        cmd.arg("--model").arg(m);
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
        let dashboard_path = PathBuf::from(home)
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
    spawn_reader(app.clone(), term_id.clone(), stdout, "stdout");
    spawn_reader(app.clone(), term_id.clone(), stderr, "stderr");
    spawn_exit_watcher(app.clone(), term_id.clone());

    let stdin_writer: Box<dyn Write + Send> = Box::new(stdin);
    let entry = ChatChild {
        child,
        stdin: Arc::new(Mutex::new(stdin_writer)),
        session_id: args.resume_session_id.clone(),
    };
    state.inner.lock().unwrap().insert(term_id.clone(), entry);

    Ok(ChatSpawnResult {
        term_id,
        session_id: None,
    })
}

fn which_claude() -> Result<PathBuf, String> {
    // Mirror pty::resolve_claude_bin behavior — PATH first, then a few
    // common Homebrew prefixes. Surfaced as a string so the webview can
    // show a useful error if the user doesn't have claude installed.
    if let Ok(out) = Command::new("which").arg("claude").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() && PathBuf::from(&p).is_file() {
                return Ok(PathBuf::from(p));
            }
        }
    }
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let p = PathBuf::from(prefix).join("claude");
        if p.is_file() {
            return Ok(p);
        }
    }
    Err("claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code or brew install claude".to_string())
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    term_id: String,
    reader: R,
    stream: &'static str,
) {
    thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            match line {
                Ok(line) => {
                    if line.is_empty() {
                        continue;
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
    // Shell out to /bin/kill so we don't pull in `nix` as a dependency
    // just for one signal call. macOS / Linux only — Tauri windows
    // build (when we get there) will need a different path.
    let status = Command::new("/bin/kill")
        .arg("-INT")
        .arg(pid.to_string())
        .status()
        .map_err(|e| format!("kill spawn: {e}"))?;
    if !status.success() {
        return Err(format!("kill -INT exited {status}"));
    }
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
        Err(e) => return Err(format!("read jsonl: {e}")),
    };
    Ok(raw.lines().filter(|l| !l.is_empty()).map(|s| s.to_string()).collect())
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
