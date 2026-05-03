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
    if let Some(e) = args.effort.as_ref() {
        cmd.arg("--effort").arg(e);
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
        let workflows_path = PathBuf::from(home).join(".deepthix").join("workflows.json");
        cmd.env(
            "DEEPTHIX_WORKFLOWS_PATH",
            workflows_path.to_string_lossy().to_string(),
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
    spawn_reader(app.clone(), term_id.clone(), stdout, "stdout");
    spawn_reader(app.clone(), term_id.clone(), stderr, "stderr");
    spawn_exit_watcher(app.clone(), term_id.clone());

    let stdin_writer: Box<dyn Write + Send> = Box::new(stdin);
    let entry = ChatChild {
        child,
        stdin: Arc::new(Mutex::new(stdin_writer)),
        session_id: args.resume_session_id.clone(),
        cwd: args.cwd.clone(),
        skip_permissions: args.skip_permissions,
        effort: args.effort.clone(),
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
    // then settle briefly + remove + hard-kill to be sure.
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
    let claude_bin = which_claude()?;
    let mut cmd = Command::new(&claude_bin);
    cmd.current_dir(&cwd)
        .arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
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
        let workflows_path = PathBuf::from(home).join(".deepthix").join("workflows.json");
        cmd.env(
            "DEEPTHIX_WORKFLOWS_PATH",
            workflows_path.to_string_lossy().to_string(),
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

    spawn_reader(app.clone(), term_id.clone(), stdout, "stdout");
    spawn_reader(app.clone(), term_id.clone(), stderr, "stderr");
    spawn_exit_watcher(app.clone(), term_id.clone());

    let stdin_writer: Box<dyn Write + Send> = Box::new(stdin);
    let entry = ChatChild {
        child,
        stdin: Arc::new(Mutex::new(stdin_writer)),
        session_id: Some(session_id),
        cwd,
        skip_permissions,
        effort: prev_effort,
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
    let claude_bin = which_claude()?;
    let mut cmd = Command::new(&claude_bin);
    cmd.current_dir(&cwd)
        .arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
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
        let workflows_path = PathBuf::from(home).join(".deepthix").join("workflows.json");
        cmd.env(
            "DEEPTHIX_WORKFLOWS_PATH",
            workflows_path.to_string_lossy().to_string(),
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

    spawn_reader(app.clone(), term_id.clone(), stdout, "stdout");
    spawn_reader(app.clone(), term_id.clone(), stderr, "stderr");
    spawn_exit_watcher(app.clone(), term_id.clone());

    let stdin_writer: Box<dyn Write + Send> = Box::new(stdin);
    let entry = ChatChild {
        child,
        stdin: Arc::new(Mutex::new(stdin_writer)),
        session_id: Some(session_id),
        cwd,
        skip_permissions,
        effort: next_effort,
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
        Err(e) => return Err(format!("read jsonl: {e}")),
    };
    Ok(raw.lines().filter(|l| !l.is_empty()).map(|s| s.to_string()).collect())
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
        Err(e) => return Err(format!("read jsonl: {e}")),
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
