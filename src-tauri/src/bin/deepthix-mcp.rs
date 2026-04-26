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
    let raw = project_cwd.to_string_lossy();
    let hash: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' => '-',
            other => other,
        })
        .collect();
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".claude")
        .join("projects")
        .join(hash)
        .join(format!("{session_id}.jsonl"))
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
