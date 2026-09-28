//! Conversation-list helpers for the sidebar: last-message previews read
//! from the tail of each session's JSONL transcript.
//!
//! Only the last `TAIL_BYTES` of a transcript are read — long sessions reach
//! 8-10 MB and the sidebar polls every open session, so a full read would
//! be far too slow.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// How much of the transcript tail to scan for the latest message.
const TAIL_BYTES: u64 = 128 * 1024;
/// Max characters kept in a preview line.
const PREVIEW_CHARS: usize = 140;

#[derive(Debug, Clone, Deserialize)]
pub struct PreviewRequest {
    pub cwd: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionPreview {
    pub session_id: String,
    /// Last-modified time of the transcript (0 when it doesn't exist yet).
    pub mtime_ms: u64,
    /// "user" | "assistant" | "" (nothing readable found).
    pub last_role: String,
    /// Single-line, markdown-stripped excerpt of the latest message.
    pub last_text: String,
}

/// Collapse whitespace, drop the most common markdown markers and cut to
/// `PREVIEW_CHARS` characters (char-safe, never splits a UTF-8 sequence).
fn clean_preview(raw: &str) -> String {
    let flat: String = raw
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !matches!(c, '*' | '`' | '#' | '>' | '_'))
        .collect();
    let collapsed = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= PREVIEW_CHARS {
        collapsed
    } else {
        let cut: String = collapsed.chars().take(PREVIEW_CHARS).collect();
        format!("{}…", cut.trim_end())
    }
}

/// Extract (role, text) from one JSONL record if it is a human-readable
/// user or assistant message. Tool results, tool calls, sidechain
/// (sub-agent) records and meta records are skipped.
fn readable_message(line: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let kind = v.get("type")?.as_str()?;
    if kind != "user" && kind != "assistant" {
        return None;
    }
    if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false)
        || v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false)
    {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let trimmed = text.trim();
    // Skip slash-command / system-injected wrappers (e.g. <command-name>).
    if trimmed.is_empty() || trimmed.starts_with('<') {
        return None;
    }
    Some((kind.to_string(), clean_preview(trimmed)))
}

/// Read the transcript tail and return the latest readable message.
fn preview_for_path(path: &Path) -> std::io::Result<(u64, String, String)> {
    let mut file = std::fs::File::open(path)?;
    let meta = file.metadata()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let len = meta.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    // The first line is probably cut mid-record when we seeked.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    for line in lines.iter().rev() {
        if let Some((role, preview)) = readable_message(line) {
            return Ok((mtime_ms, role, preview));
        }
    }
    Ok((mtime_ms, String::new(), String::new()))
}

/// Latest-message preview for each requested session. Missing or
/// unreadable transcripts yield an empty preview instead of an error so
/// one broken file never blanks the whole sidebar.
#[tauri::command]
pub fn session_previews(items: Vec<PreviewRequest>) -> Vec<SessionPreview> {
    items
        .into_iter()
        .map(|req| {
            let path = crate::jsonl_watcher::predict_jsonl_path(Path::new(&req.cwd), &req.session_id);
            match preview_for_path(&path) {
                Ok((mtime_ms, last_role, last_text)) => SessionPreview {
                    session_id: req.session_id,
                    mtime_ms,
                    last_role,
                    last_text,
                },
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(
                            target: "deepthix::conversations",
                            ?path, error = %e, "session preview failed",
                        );
                    }
                    SessionPreview {
                        session_id: req.session_id,
                        mtime_ms: 0,
                        last_role: String::new(),
                        last_text: String::new(),
                    }
                }
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn clean_preview_strips_markdown_and_truncates() {
        assert_eq!(clean_preview("**Bonjour**\n\n`code` # titre"), "Bonjour code titre");
        let long = "é".repeat(300);
        let out = clean_preview(&long);
        assert_eq!(out.chars().count(), PREVIEW_CHARS + 1); // + ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn readable_message_skips_tool_results_and_sidechains() {
        let tool = r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}"#;
        assert!(readable_message(tool).is_none());
        let side = r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"sub"}]}}"#;
        assert!(readable_message(side).is_none());
        let cmd = r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#;
        assert!(readable_message(cmd).is_none());
        let ok = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Voici **12** factures"}]}}"#;
        assert_eq!(
            readable_message(ok),
            Some(("assistant".to_string(), "Voici 12 factures".to_string()))
        );
    }

    #[test]
    fn preview_for_path_returns_latest_readable_message() {
        let dir = std::env::temp_dir().join(format!("dt-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, r#"{{"type":"user","message":{{"content":"Première question"}}}}"#).unwrap();
        writeln!(f, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"Réponse finale"}}]}}}}"#).unwrap();
        writeln!(f, r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","content":"ignored"}}]}}}}"#).unwrap();
        drop(f);
        let (mtime, role, text) = preview_for_path(&path).unwrap();
        assert!(mtime > 0);
        assert_eq!(role, "assistant");
        assert_eq!(text, "Réponse finale");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn session_previews_tolerates_missing_files() {
        let out = session_previews(vec![PreviewRequest {
            cwd: "C:\\definitely\\missing".into(),
            session_id: "nope".into(),
        }]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].mtime_ms, 0);
        assert!(out[0].last_text.is_empty());
    }
}
