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
pub async fn session_previews(items: Vec<PreviewRequest>) -> Result<Vec<SessionPreview>, String> {
    tauri::async_runtime::spawn_blocking(move || session_previews_blocking(items))
        .await
        .map_err(|e| e.to_string())
}

fn session_previews_blocking(items: Vec<PreviewRequest>) -> Vec<SessionPreview> {
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

// ── Full-text search across transcripts ─────────────────────────────────

/// Max hits returned overall / per session.
const SEARCH_MAX_HITS: usize = 50;
const SEARCH_MAX_PER_SESSION: usize = 3;
/// Characters of context kept before / after the match in a snippet.
const SNIPPET_BEFORE: usize = 50;
const SNIPPET_AFTER: usize = 110;

#[derive(Debug, Clone, Deserialize)]
pub struct SearchProject {
    pub project_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchHit {
    pub project_id: String,
    pub session_id: String,
    /// Transcript mtime (sort key: newest conversations first).
    pub mtime_ms: u64,
    /// "user" | "assistant".
    pub role: String,
    /// Single-line excerpt around the match (may start/end with "…").
    pub snippet: String,
}

/// Lowercase + strip the accents that matter in French so "emission"
/// finds "Émission". Keeps a 1:1 char mapping so match offsets computed on
/// the folded text are valid on the original.
fn fold(s: &str) -> String {
    s.chars()
        .map(|c| {
            let l = c.to_lowercase().next().unwrap_or(c);
            match l {
                'à' | 'â' | 'ä' | 'á' | 'ã' => 'a',
                'é' | 'è' | 'ê' | 'ë' => 'e',
                'î' | 'ï' | 'í' => 'i',
                'ô' | 'ö' | 'ó' | 'õ' => 'o',
                'ù' | 'û' | 'ü' | 'ú' => 'u',
                'ç' => 'c',
                'ÿ' => 'y',
                other => other,
            }
        })
        .collect()
}

/// Excerpt of `text` around the first occurrence of the folded query.
fn snippet_around(text: &str, folded_query: &str) -> Option<String> {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = flat.chars().collect();
    let folded: Vec<char> = fold(&flat).chars().collect();
    let q: Vec<char> = folded_query.chars().collect();
    if q.is_empty() || q.len() > folded.len() {
        return None;
    }
    let pos = (0..=folded.len() - q.len()).find(|&i| folded[i..i + q.len()] == q[..])?;
    let start = pos.saturating_sub(SNIPPET_BEFORE);
    let end = (pos + q.len() + SNIPPET_AFTER).min(chars.len());
    let mut out: String = chars[start..end].iter().collect();
    if start > 0 {
        out = format!("…{}", out.trim_start());
    }
    if end < chars.len() {
        out = format!("{}…", out.trim_end());
    }
    Some(out)
}

/// Readable text of a user/assistant record (no tool results, sidechains
/// or meta / slash-command wrappers).
fn record_text(v: &serde_json::Value) -> Option<(String, String)> {
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
    if text.trim().is_empty() || text.trim_start().starts_with('<') {
        return None;
    }
    Some((kind.to_string(), text))
}

fn file_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Search every transcript of the given projects, newest first.
pub fn search_transcripts(projects: &[SearchProject], query: &str) -> Vec<SearchHit> {
    let folded_query = fold(query.trim());
    if folded_query.chars().count() < 2 {
        return vec![];
    }
    // (mtime, project_id, path) for every transcript, newest first.
    let mut files: Vec<(u64, String, std::path::PathBuf)> = Vec::new();
    for p in projects {
        let probe = crate::jsonl_watcher::predict_jsonl_path(Path::new(&p.cwd), "probe");
        let Some(dir) = probe.parent() else { continue };
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                files.push((file_mtime_ms(&path), p.project_id.clone(), path));
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));

    let mut hits = Vec::new();
    for (mtime_ms, project_id, path) in files {
        if hits.len() >= SEARCH_MAX_HITS {
            break;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let mut per_session = 0;
        // Newest lines first so each session shows its latest mentions.
        for line in raw.lines().rev() {
            if per_session >= SEARCH_MAX_PER_SESSION || hits.len() >= SEARCH_MAX_HITS {
                break;
            }
            // Cheap pre-filter before JSON parsing.
            if !fold(line).contains(&folded_query) {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let Some((role, text)) = record_text(&v) else { continue };
            if let Some(snippet) = snippet_around(&text, &folded_query) {
                hits.push(SearchHit {
                    project_id: project_id.clone(),
                    session_id: session_id.clone(),
                    mtime_ms,
                    role,
                    snippet,
                });
                per_session += 1;
            }
        }
    }
    hits
}

/// Full-text search across all transcripts of the given projects. Runs on
/// a blocking worker so large histories never freeze the UI thread.
#[tauri::command]
pub async fn search_conversations(
    projects: Vec<SearchProject>,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || search_transcripts(&projects, &query))
        .await
        .map_err(|e| e.to_string())
}

// ── Move a conversation to another project ──────────────────────────────

/// Recursive copy; returns the number of bytes copied.
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<u64> {
    std::fs::create_dir_all(dst)?;
    let mut bytes = 0;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            bytes += copy_dir(&entry.path(), &to)?;
        } else {
            bytes += std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(bytes)
}

/// Move `<sid>.jsonl` (and its optional `<sid>/` folder: tool results,
/// sub-agents) from one Claude project folder to another. Claude Code only
/// resumes a session from the folder of the project it is stored in, so a
/// tab moved to another project needs its transcript moved too.
///
/// Safe order: copy → verify size → delete originals. Refuses to overwrite
/// an existing conversation at the destination. Nothing in the user's
/// project folders (code, documents) is touched.
pub fn move_session_files(src_dir: &Path, dst_dir: &Path, session_id: &str) -> Result<(), String> {
    if src_dir == dst_dir {
        return Ok(());
    }
    let src_file = src_dir.join(format!("{session_id}.jsonl"));
    let dst_file = dst_dir.join(format!("{session_id}.jsonl"));
    let src_sub = src_dir.join(session_id);
    let dst_sub = dst_dir.join(session_id);
    if !src_file.exists() {
        return Err(format!("conversation introuvable : {}", src_file.display()));
    }
    if dst_file.exists() || dst_sub.exists() {
        return Err(format!("une conversation {session_id} existe déjà dans le projet de destination"));
    }
    std::fs::create_dir_all(dst_dir).map_err(|e| e.to_string())?;

    let expected = std::fs::metadata(&src_file).map_err(|e| e.to_string())?.len();
    let copied = std::fs::copy(&src_file, &dst_file).map_err(|e| e.to_string())?;
    if copied != expected {
        let _ = std::fs::remove_file(&dst_file);
        return Err("copie incomplète de la conversation — rien n'a été déplacé".to_string());
    }
    if src_sub.is_dir() {
        if let Err(e) = copy_dir(&src_sub, &dst_sub) {
            let _ = std::fs::remove_file(&dst_file);
            let _ = std::fs::remove_dir_all(&dst_sub);
            return Err(format!("copie du dossier de la conversation impossible ({e}) — rien n'a été déplacé"));
        }
    }
    // Copies are in place: now drop the originals.
    std::fs::remove_file(&src_file).map_err(|e| e.to_string())?;
    if src_sub.is_dir() {
        std::fs::remove_dir_all(&src_sub).map_err(|e| e.to_string())?;
    }
    tracing::info!(
        target: "deepthix::conversations",
        %session_id, from = ?src_dir, to = ?dst_dir, bytes = copied, "moved conversation",
    );
    Ok(())
}

/// Move a conversation's transcript from one project to another (see
/// `move_session_files`). The caller stops the agent first.
#[tauri::command]
pub async fn move_session(session_id: String, from_cwd: String, to_cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = crate::jsonl_watcher::predict_jsonl_path(Path::new(&from_cwd), &session_id);
        let dst = crate::jsonl_watcher::predict_jsonl_path(Path::new(&to_cwd), &session_id);
        let (Some(src_dir), Some(dst_dir)) = (src.parent(), dst.parent()) else {
            return Err("dossier de conversation introuvable".to_string());
        };
        move_session_files(src_dir, dst_dir, &session_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn move_session_files_moves_transcript_and_subfolder() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("A");
        let b = root.path().join("B");
        std::fs::create_dir_all(a.join("s1").join("tool-results")).unwrap();
        std::fs::write(a.join("s1.jsonl"), "line1\nline2\n").unwrap();
        std::fs::write(a.join("s1").join("tool-results").join("r.txt"), "x").unwrap();
        std::fs::write(a.join("other.jsonl"), "keep").unwrap();

        move_session_files(&a, &b, "s1").unwrap();
        assert_eq!(std::fs::read_to_string(b.join("s1.jsonl")).unwrap(), "line1\nline2\n");
        assert!(b.join("s1").join("tool-results").join("r.txt").exists());
        assert!(!a.join("s1.jsonl").exists());
        assert!(!a.join("s1").exists());
        assert!(a.join("other.jsonl").exists(), "other conversations untouched");
    }

    #[test]
    fn move_session_files_refuses_to_overwrite_and_keeps_source() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("A");
        let b = root.path().join("B");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("s1.jsonl"), "src").unwrap();
        std::fs::write(b.join("s1.jsonl"), "dst").unwrap();
        assert!(move_session_files(&a, &b, "s1").is_err());
        assert_eq!(std::fs::read_to_string(a.join("s1.jsonl")).unwrap(), "src");
        assert_eq!(std::fs::read_to_string(b.join("s1.jsonl")).unwrap(), "dst");
    }

    #[test]
    fn move_session_files_errors_when_missing_and_noops_same_dir() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("A");
        std::fs::create_dir_all(&a).unwrap();
        assert!(move_session_files(&a, &root.path().join("B"), "nope").is_err());
        std::fs::write(a.join("s.jsonl"), "x").unwrap();
        move_session_files(&a, &a, "s").unwrap();
        assert!(a.join("s.jsonl").exists());
    }

    #[test]
    fn fold_strips_french_accents() {
        assert_eq!(fold("Émission Ça"), "emission ca");
    }

    #[test]
    fn snippet_around_finds_accent_insensitive_match() {
        let text = "Bonjour.\n\nLes émissions FE02 sont suspendues jusqu'à nouvel ordre.";
        let s = snippet_around(text, &fold("EMISSIONS")).unwrap();
        assert!(s.contains("émissions FE02"), "{s}");
        assert!(!s.contains('\n'));
        assert!(snippet_around(text, "hubspot").is_none());
    }

    #[test]
    fn search_transcripts_finds_hits_and_skips_tool_results() {
        let cwd = format!("C:\\dt-search-test-{}", std::process::id());
        let path = crate::jsonl_watcher::predict_jsonl_path(Path::new(&cwd), "sess-1");
        let dir = path.parent().unwrap().to_path_buf();
        // Guard: only ever touch a throwaway dir named after this test.
        assert!(dir.to_string_lossy().contains("dt-search-test-"));
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, r#"{{"type":"user","message":{{"content":"Relance les émissions FE02"}}}}"#).unwrap();
        writeln!(f, r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","content":"emissions in tool output"}}]}}}}"#).unwrap();
        writeln!(f, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"Émissions relancées."}}]}}}}"#).unwrap();
        drop(f);
        let hits = search_transcripts(
            &[SearchProject { project_id: "p".into(), cwd: cwd.clone() }],
            "emissions",
        );
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_eq!(hits[0].role, "assistant"); // newest line first
        assert_eq!(hits[0].session_id, "sess-1");
        assert!(hits.iter().all(|h| !h.snippet.contains("tool output")));
    }

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
        let out = session_previews_blocking(vec![PreviewRequest {
            cwd: "C:\\definitely\\missing".into(),
            session_id: "nope".into(),
        }]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].mtime_ms, 0);
        assert!(out[0].last_text.is_empty());
    }
}
