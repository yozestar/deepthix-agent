//! deepthix-mcp — JSON-RPC 2.0 stdio MCP server.
//!
//! Claude code launches us via `--mcp-config` and we expose introspection
//! tools the orchestrator session uses to coordinate the other claude
//! sessions running inside Deepthix Agent.
//!
//! Phase 2 tools (read-only, file-system only — no Tauri IPC needed):
//! - list_sessions:           every persisted claude session across projects
//! - read_session_dashboard:  contents of <pid>/dashboards/<sid>.html
//! - read_session_transcript: tail of ~/.claude/projects/<hash>/<sid>.jsonl
//! - read_session_notes:      free-form notes from sessions.json
//!
//! Protocol: minimal MCP — handles `initialize`, `tools/list`, `tools/call`.
//! Anything else returns a JSON-RPC method-not-found.
//!
//! No deps beyond serde / serde_json / dirs (already in Cargo.toml). All
//! synchronous — one request per stdin line, response per stdout line.

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "deepthix";
const SERVER_VERSION: &str = "0.1.0";

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

fn ok(id: Value, result: Value) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(result),
        error: None,
    }
}

fn err(id: Value, code: i64, message: String) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}

fn text_result(text: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false
    })
}

fn err_result(text: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": true
    })
}

fn deepthix_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".deepthix"))
}

// ─── Tool implementations ────────────────────────────────────────────────

#[derive(Serialize)]
struct SessionRow {
    project_id: String,
    project_name: String,
    project_path: String,
    session_id: String,
    label: String,
    cwd: String,
    notes: String,
    skip_permissions: bool,
}

fn tool_list_sessions(_args: &Value) -> Result<Value, String> {
    let dt = deepthix_dir().ok_or("no home dir")?;
    let projects_path = dt.join("projects.json");
    // Project metadata: { projects: [{id, name, path}, ...] }
    let project_meta: Value = match std::fs::read_to_string(&projects_path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or(json!({})),
        Err(_) => json!({}),
    };
    let mut name_lookup = std::collections::HashMap::new();
    let mut path_lookup = std::collections::HashMap::new();
    if let Some(arr) = project_meta.get("projects").and_then(|v| v.as_array()) {
        for p in arr {
            if let (Some(id), Some(name), Some(path)) = (
                p.get("id").and_then(|v| v.as_str()),
                p.get("name").and_then(|v| v.as_str()),
                p.get("path").and_then(|v| v.as_str()),
            ) {
                name_lookup.insert(id.to_string(), name.to_string());
                path_lookup.insert(id.to_string(), path.to_string());
            }
        }
    }

    let mut rows: Vec<SessionRow> = Vec::new();
    let projects_subdir = dt.join("projects");
    let entries = match std::fs::read_dir(&projects_subdir) {
        Ok(e) => e,
        Err(_) => return Ok(json!({ "sessions": [] })),
    };
    for entry in entries.flatten() {
        let project_id = entry.file_name().to_string_lossy().into_owned();
        let sessions_json = entry.path().join("sessions.json");
        let raw = match std::fs::read_to_string(&sessions_json) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let sessions: Vec<Value> = match serde_json::from_str(&raw) {
            Ok(s) => s,
            Err(_) => continue,
        };
        for s in sessions {
            let session_id = s
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if session_id.is_empty() {
                continue;
            }
            rows.push(SessionRow {
                project_id: project_id.clone(),
                project_name: name_lookup
                    .get(&project_id)
                    .cloned()
                    .unwrap_or_else(|| project_id.clone()),
                project_path: path_lookup
                    .get(&project_id)
                    .cloned()
                    .unwrap_or_default(),
                session_id,
                label: s
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                cwd: s
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                notes: s
                    .get("notes")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                skip_permissions: s
                    .get("skip_permissions")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            });
        }
    }
    Ok(json!({ "sessions": rows }))
}

fn find_session_in_disk(session_id: &str) -> Option<(String, PathBuf)> {
    // Returns (project_id, project_dir) for the project that owns
    // session_id, or None if not found.
    let dt = deepthix_dir()?;
    let projects_subdir = dt.join("projects");
    let entries = std::fs::read_dir(&projects_subdir).ok()?;
    for entry in entries.flatten() {
        let project_id = entry.file_name().to_string_lossy().into_owned();
        let sessions_json = entry.path().join("sessions.json");
        let raw = match std::fs::read_to_string(&sessions_json) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let sessions: Vec<Value> = match serde_json::from_str(&raw) {
            Ok(s) => s,
            Err(_) => continue,
        };
        for s in sessions {
            if s.get("session_id").and_then(|v| v.as_str()) == Some(session_id) {
                return Some((project_id, entry.path()));
            }
        }
    }
    None
}

fn tool_read_dashboard(args: &Value) -> Result<Value, String> {
    let session_id = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or("missing session_id")?;
    let (_pid, dir) =
        find_session_in_disk(session_id).ok_or_else(|| format!("unknown session_id {session_id}"))?;
    let path = dir.join("dashboards").join(format!("{session_id}.html"));
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(json!({
            "session_id": session_id,
            "path": path.to_string_lossy(),
            "html": s,
            "size_bytes": s.len(),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({
            "session_id": session_id,
            "path": path.to_string_lossy(),
            "html": "",
            "size_bytes": 0,
            "note": "no dashboard written yet",
        })),
        Err(e) => Err(e.to_string()),
    }
}

fn predict_jsonl_path(project_cwd: &Path, session_id: &str) -> PathBuf {
    // Mirror jsonl_watcher::predict_jsonl_path. Claude Code's actual
    // hash rule is "any non-alphanumeric ASCII (except `-`) -> `-`".
    // Keeping the two implementations in lockstep matters: this MCP
    // sidecar has to find the same JSONL file the main app does for
    // tool_read_transcript to work on Windows projects with `_` or
    // spaces in the path.
    let raw = project_cwd.to_string_lossy();
    let hash: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let safe_session_id: String = session_id
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0' => '-',
            c if c.is_control() => '-',
            other => other,
        })
        .collect();
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".claude")
        .join("projects")
        .join(hash)
        .join(format!("{safe_session_id}.jsonl"))
}

fn tool_read_transcript(args: &Value) -> Result<Value, String> {
    let session_id = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or("missing session_id")?;
    let last_n = args
        .get("last_n")
        .and_then(|v| v.as_u64())
        .unwrap_or(20)
        .min(500) as usize;

    // Find session entry to grab cwd → derive JSONL path.
    let (_pid, dir) =
        find_session_in_disk(session_id).ok_or_else(|| format!("unknown session_id {session_id}"))?;
    let raw = std::fs::read_to_string(dir.join("sessions.json")).map_err(|e| e.to_string())?;
    let sessions: Vec<Value> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let entry = sessions
        .iter()
        .find(|s| s.get("session_id").and_then(|v| v.as_str()) == Some(session_id))
        .ok_or("session row missing")?;
    let cwd = entry.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let jsonl = predict_jsonl_path(Path::new(cwd), session_id);

    let body = match std::fs::read_to_string(&jsonl) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({
                "session_id": session_id,
                "path": jsonl.to_string_lossy(),
                "lines": [],
                "note": "JSONL transcript does not exist yet",
            }))
        }
        Err(e) => return Err(e.to_string()),
    };
    let lines: Vec<&str> = body.lines().collect();
    let start = lines.len().saturating_sub(last_n);
    let tail: Vec<String> = lines[start..].iter().map(|s| s.to_string()).collect();
    Ok(json!({
        "session_id": session_id,
        "path": jsonl.to_string_lossy(),
        "total_lines": lines.len(),
        "returned": tail.len(),
        "lines": tail,
    }))
}

fn tool_read_notes(args: &Value) -> Result<Value, String> {
    let session_id = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or("missing session_id")?;
    let (_pid, dir) =
        find_session_in_disk(session_id).ok_or_else(|| format!("unknown session_id {session_id}"))?;
    let raw = std::fs::read_to_string(dir.join("sessions.json")).map_err(|e| e.to_string())?;
    let sessions: Vec<Value> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let entry = sessions
        .iter()
        .find(|s| s.get("session_id").and_then(|v| v.as_str()) == Some(session_id))
        .ok_or("session row missing")?;
    Ok(json!({
        "session_id": session_id,
        "label": entry.get("label").and_then(|v| v.as_str()).unwrap_or(""),
        "notes": entry.get("notes").and_then(|v| v.as_str()).unwrap_or(""),
    }))
}

/// Append a single notification record to ~/.deepthix/notifications.jsonl.
/// The Tauri app watches this file and turns each new line into an in-app
/// toast + macOS banner. We don't try to surface the result back to claude
/// — the user is the destination, claude just publishes.
fn tool_notify_user(args: &Value) -> Result<Value, String> {
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .ok_or("missing title")?
        .trim()
        .to_string();
    if title.is_empty() {
        return Err("title cannot be empty".into());
    }
    let body = args
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("info")
        .to_string();
    let source = args
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("mcp")
        .to_string();
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let record = json!({
        "title": title,
        "body": body,
        "kind": kind,
        "source": source,
        "ts_ms": ts_ms,
    });
    let home = dirs::home_dir().ok_or("no home dir")?;
    let path = home.join(".deepthix").join("notifications.jsonl");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "title": title, "kind": kind }))
}

// Concurrent-subtask cap. Each sub-claude is a full claude-code process
// (~200 MB resident, full token budget). Beyond 3 the user's machine
// thrashes — and so does their wallet, since every subtask burns its
// own request budget against the shared rate limit. Process-local
// counter is enough; the deepthix-mcp sidecar runs once per claude
// session, and within that session claude's tool calls are serialized.
const MAX_CONCURRENT_SUBTASKS: usize = 3;
static SUBTASK_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Spawn `claude --print -p "<prompt>"` in batch mode (NOT stream-json),
/// wait for it to finish, return the assistant's final text. Replaces
/// the broken `Task` / `Agent` built-in tool when the parent claude is
/// running under Deepthix Agent's stream-json bridge.
fn tool_run_subtask(args: &Value) -> Result<Value, String> {
    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .ok_or("missing prompt")?
        .trim()
        .to_string();
    if prompt.is_empty() {
        return Err("prompt cannot be empty".into());
    }
    if prompt.len() > 200_000 {
        return Err(format!(
            "prompt too large ({} chars > 200000)",
            prompt.len()
        ));
    }
    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("subtask")
        .trim()
        .to_string();
    let cwd_arg = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let model = args
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Bump in-flight counter and gate. If we're already at the cap,
    // refuse — better to fail fast than to fill swap.
    let prev = SUBTASK_COUNT.fetch_add(1, Ordering::SeqCst);
    if prev >= MAX_CONCURRENT_SUBTASKS {
        SUBTASK_COUNT.fetch_sub(1, Ordering::SeqCst);
        return Err(format!(
            "Too many concurrent sub-tasks ({}/{}). Wait for one to finish before launching another.",
            prev, MAX_CONCURRENT_SUBTASKS,
        ));
    }
    // Decrement on every return path via this guard.
    struct CounterGuard;
    impl Drop for CounterGuard {
        fn drop(&mut self) {
            SUBTASK_COUNT.fetch_sub(1, Ordering::SeqCst);
        }
    }
    let _guard = CounterGuard;

    let claude_bin = which_claude_bin()?;
    let cwd = cwd_arg
        .or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_else(|| ".".into());

    let mut cmd = Command::new(&claude_bin);
    cmd.current_dir(&cwd)
        .arg("--print")
        // -p PROMPT is the official batch mode for one-shot tasks.
        .arg("-p")
        .arg(&prompt)
        // Skip permissions in the sub — the parent already has the user's
        // consent (Deepthix UI's skipPermissions toggle).
        .arg("--dangerously-skip-permissions")
        // Plain text output (default) — we just want the final reply.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(m) = model.as_ref() {
        cmd.arg("--model").arg(m);
    }

    let started_at = std::time::Instant::now();
    let log_label = if description.len() > 60 {
        format!("{}…", &description[..60])
    } else {
        description.clone()
    };
    eprintln!("[deepthix-mcp] subtask START — \"{log_label}\" cwd={cwd}");

    let output = cmd
        .output()
        .map_err(|e| format!("spawn claude --print -p: {e}"))?;
    let elapsed_ms = started_at.elapsed().as_millis();
    let exit_code = output.status.code().unwrap_or(-1);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!(
            "[deepthix-mcp] subtask FAILED — \"{log_label}\" exit={exit_code} elapsed={elapsed_ms}ms"
        );
        return Err(format!(
            "sub-task exited {exit_code}: {}",
            stderr.lines().take(20).collect::<Vec<_>>().join("\n")
        ));
    }

    let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let raw_len = stdout.len();
    // Cap the returned text — claude tool_result has practical limits
    // and 100k+ chars in a single block makes the parent context blow.
    const MAX_OUT: usize = 50_000;
    let truncated = stdout.len() > MAX_OUT;
    if truncated {
        stdout.truncate(MAX_OUT);
        stdout.push_str("\n\n…(truncated, full output in deepthix-mcp logs)");
    }
    eprintln!(
        "[deepthix-mcp] subtask DONE — \"{log_label}\" elapsed={elapsed_ms}ms chars={raw_len}{}",
        if truncated { " (truncated)" } else { "" }
    );

    Ok(json!({
        "ok": true,
        "description": description,
        "elapsed_ms": elapsed_ms,
        "chars": raw_len,
        "truncated": truncated,
        "output": stdout,
    }))
}

/// Find the `claude` CLI on PATH or in the canonical install paths
/// (mirrors src-tauri/src/claude_bin.rs but kept inline here so the
/// sidecar binary doesn't depend on the main lib crate).
fn which_claude_bin() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join("claude");
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    let candidates: Vec<PathBuf> = {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut v = vec![
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
            PathBuf::from("/usr/bin/claude"),
        ];
        if !home.is_empty() {
            let hp = PathBuf::from(home);
            v.push(hp.join(".local/bin/claude"));
            v.push(hp.join(".npm-global/bin/claude"));
            v.push(hp.join(".bun/bin/claude"));
        }
        v
    };
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "claude CLI not found in PATH or fallback paths".to_string())
}

// ─── Tools list (advertised via tools/list) ──────────────────────────────

fn tools_definition() -> Value {
    json!([
        {
            "name": "list_sessions",
            "description": "List every persisted claude session across all Deepthix projects. Returns project_id, project_name, project_path, session_id, label, cwd, notes, skip_permissions for each. Call this first to know which sessions exist before reading their dashboards/transcripts/notes.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "read_session_dashboard",
            "description": "Read the live HTML dashboard a claude session has written to its dashboard.html. This is the at-a-glance summary the user pinned for that session. Empty string if the session never wrote anything.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session UUID (from list_sessions)" }
                },
                "required": ["session_id"]
            }
        },
        {
            "name": "read_session_transcript",
            "description": "Tail the JSONL transcript of a claude session — useful for catching up on what it just did. Returns the last N lines (default 20, max 500). Each line is a raw JSONL record (user/assistant/tool messages).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session UUID (from list_sessions)" },
                    "last_n":     { "type": "number", "description": "How many trailing lines to return. Default 20, max 500." }
                },
                "required": ["session_id"]
            }
        },
        {
            "name": "read_session_notes",
            "description": "Read the user's free-form notes pinned to a session in the OVERVIEW pane. Use this to know the user's stated context/intent for that session.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session UUID (from list_sessions)" }
                },
                "required": ["session_id"]
            }
        },
        {
            "name": "run_subtask",
            "description": "Run a sub-task in an isolated claude process and return its final output. **Use this INSTEAD of the built-in `Task` / `Agent` tool when you're inside a Deepthix Agent session** — the built-in subagent dispatch is broken in claude-code's --print --input-format stream-json mode (see issues #24594/#29618), the tool_result never comes back. This MCP tool spawns `claude --print -p` in batch mode (which works) and waits for completion. Output is the assistant's full reply (text + summary, no streaming). Use cases: heavy refactors, multi-file analyses, long research where you don't need intermediate steps. Limits: max 3 concurrent sub-tasks per host; sub-task can take up to 30 minutes; output is capped at ~50k chars (the rest is logged but truncated in the return value).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "The full sub-task prompt. Self-contained — the sub-claude has no memory of the parent conversation." },
                    "description": { "type": "string", "description": "Short label for the sub-task (5-10 words). Surfaced in Deepthix's UI + logs so the user can tell what's running." },
                    "cwd": { "type": "string", "description": "Working directory the sub-claude is spawned in. Defaults to the parent session's cwd." },
                    "model": { "type": "string", "description": "Optional model override (e.g. `sonnet`, `opus`). Defaults to inherit parent." }
                },
                "required": ["prompt", "description"]
            }
        },
        {
            "name": "notify_user",
            "description": "Push a notification to the user inside the Deepthix app (in-app toast + macOS notification banner). Use sparingly for events the user actually cares about — build done, tests failed, long-running task complete, ambiguous decision needs input. The user is watching multiple sessions; a notification interrupts whatever they're looking at, so each one should be worth that interruption.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Short headline. ~5-8 words." },
                    "body":  { "type": "string", "description": "Optional one-line detail. Empty if not useful." },
                    "kind":  { "type": "string", "enum": ["info", "success", "warn", "error"], "description": "Severity hint. Drives toast colour. Default: info." },
                    "source":{ "type": "string", "description": "Free-form origin tag (e.g. session label or task name). Helps the user know who fired this. Default: 'mcp'." }
                },
                "required": ["title"]
            }
        }
    ])
}

// ─── Dispatcher ──────────────────────────────────────────────────────────

fn handle_tools_call(params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("missing tool name")?;
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    let result = match name {
        "list_sessions" => tool_list_sessions(&args),
        "read_session_dashboard" => tool_read_dashboard(&args),
        "read_session_transcript" => tool_read_transcript(&args),
        "read_session_notes" => tool_read_notes(&args),
        "notify_user" => tool_notify_user(&args),
        "run_subtask" => tool_run_subtask(&args),
        other => return Err(format!("unknown tool: {other}")),
    };
    match result {
        Ok(v) => Ok(text_result(serde_json::to_string_pretty(&v).unwrap_or_default())),
        Err(e) => Ok(err_result(e)),
    }
}

fn handle_request(req: JsonRpcRequest) -> Option<JsonRpcResponse> {
    let id = req.id.unwrap_or(json!(null));
    match req.method.as_str() {
        "initialize" => Some(ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": SERVER_VERSION
                }
            }),
        )),
        "notifications/initialized" => None, // notifications get no response
        "tools/list" => Some(ok(id, json!({ "tools": tools_definition() }))),
        "tools/call" => match handle_tools_call(&req.params) {
            Ok(v) => Some(ok(id, v)),
            Err(e) => Some(err(id, -32000, e)),
        },
        // Not-supported but answer politely so claude doesn't disconnect.
        "ping" => Some(ok(id, json!({}))),
        other => Some(err(id, -32601, format!("method not found: {other}"))),
    }
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = err(json!(null), -32700, format!("parse error: {e}"));
                let _ = writeln!(stdout, "{}", serde_json::to_string(&resp).unwrap());
                let _ = stdout.flush();
                continue;
            }
        };
        if let Some(resp) = handle_request(req) {
            let _ = writeln!(stdout, "{}", serde_json::to_string(&resp).unwrap());
            let _ = stdout.flush();
        }
    }
}
