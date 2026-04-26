// Aggregates claude code token usage from the canonical JSONL transcripts
// at ~/.claude/projects/*/*.jsonl. Each `assistant` record carries a
// `usage` object with input/output/cache tokens; we sum these by model
// (across every project, every session) plus a "today" bucket scoped to
// records whose timestamp falls in the current local calendar day.
//
// Cost is computed at the JS layer from the per-model token breakdown
// since pricing rates churn faster than the Rust side wants to know
// about. The Rust call returns raw counts only.

use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ModelUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

impl ModelUsage {
    fn add(&mut self, other: &ModelUsage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_creation_input_tokens += other.cache_creation_input_tokens;
        self.cache_read_input_tokens += other.cache_read_input_tokens;
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ClaudeUsage {
    /// All-time totals keyed by model name (e.g. "claude-opus-4-7").
    pub all_time: HashMap<String, ModelUsage>,
    /// Today (local timezone) totals keyed by model name. A subset of all_time.
    pub today: HashMap<String, ModelUsage>,
    /// Number of JSONL files scanned. Useful as a sanity signal in the UI.
    pub session_count: u64,
}

#[derive(Debug, Deserialize)]
struct JsonlRecord {
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    message: Option<MessageBlock>,
}

#[derive(Debug, Deserialize)]
struct MessageBlock {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<UsageBlock>,
}

#[derive(Debug, Default, Deserialize)]
struct UsageBlock {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
}

/// Today's date in the LOCAL timezone, as a NaiveDate (yyyy-mm-dd).
fn today_local() -> NaiveDate {
    Local::now().date_naive()
}

/// Whether `iso_ts` (claude's timestamp, e.g. "2026-04-26T08:34:12.123Z")
/// falls on `target` in the local timezone.
fn ts_is_on_local_date(iso_ts: &str, target: NaiveDate) -> bool {
    // claude writes UTC ISO-8601. Parse → convert to local → date.
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(iso_ts) else {
        return false;
    };
    let local = Local.from_utc_datetime(&parsed.naive_utc());
    local.date_naive() == target
}

#[tauri::command]
pub fn read_claude_usage() -> Result<ClaudeUsage, String> {
    let projects_root = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("projects"),
        None => return Err("no home dir".to_string()),
    };
    if !projects_root.exists() {
        // Empty result is fine — user just hasn't run claude yet.
        return Ok(ClaudeUsage::default());
    }

    let today = today_local();
    let mut usage = ClaudeUsage::default();

    let project_dirs = match std::fs::read_dir(&projects_root) {
        Ok(it) => it,
        Err(e) => return Err(format!("read_dir {}: {e}", projects_root.display())),
    };
    for project_entry in project_dirs.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let session_files = match std::fs::read_dir(&project_path) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for sess in session_files.flatten() {
            let p = sess.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            usage.session_count += 1;
            scan_jsonl(&p, today, &mut usage);
        }
    }

    tracing::info!(
        target: "deepthix::commands",
        sessions = usage.session_count,
        models = usage.all_time.len(),
        today_models = usage.today.len(),
        "read_claude_usage",
    );
    Ok(usage)
}

fn scan_jsonl(path: &PathBuf, today: NaiveDate, out: &mut ClaudeUsage) {
    let content = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            tracing::debug!(target: "deepthix::usage", ?path, error = %e, "skip jsonl read");
            return;
        }
    };
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let rec: JsonlRecord = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue, // Tolerate malformed lines.
        };
        // Only `assistant` records carry usage. user / system / etc. don't.
        if rec.r#type.as_deref() != Some("assistant") {
            continue;
        }
        let Some(message) = rec.message else { continue };
        let Some(usage_block) = message.usage else { continue };
        // Skip records where the assistant emitted nothing meaningful — both
        // input AND output 0 means it's a continuation marker, not a billable
        // turn. (Cache tokens alone do count.)
        let any_tokens = usage_block.input_tokens.unwrap_or(0)
            + usage_block.output_tokens.unwrap_or(0)
            + usage_block.cache_creation_input_tokens.unwrap_or(0)
            + usage_block.cache_read_input_tokens.unwrap_or(0);
        if any_tokens == 0 {
            continue;
        }
        let model = message.model.unwrap_or_else(|| "unknown".to_string());
        let bump = ModelUsage {
            input_tokens: usage_block.input_tokens.unwrap_or(0),
            output_tokens: usage_block.output_tokens.unwrap_or(0),
            cache_creation_input_tokens: usage_block.cache_creation_input_tokens.unwrap_or(0),
            cache_read_input_tokens: usage_block.cache_read_input_tokens.unwrap_or(0),
        };
        out.all_time.entry(model.clone()).or_default().add(&bump);
        if let Some(ts) = rec.timestamp.as_deref() {
            if ts_is_on_local_date(ts, today) {
                out.today.entry(model).or_default().add(&bump);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_usage_from_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("proj-1");
        std::fs::create_dir_all(&proj).unwrap();
        let jsonl = proj.join("sess-1.jsonl");
        let body = r#"
{"type":"user","message":{"content":"hi"}}
{"type":"assistant","timestamp":"2026-04-26T08:00:00Z","message":{"model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000}}}
{"type":"assistant","timestamp":"2026-04-26T09:00:00Z","message":{"model":"claude-opus-4-7","usage":{"input_tokens":200,"output_tokens":75}}}
{"type":"assistant","timestamp":"2025-12-01T00:00:00Z","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":20}}}
"#;
        std::fs::write(&jsonl, body).unwrap();

        let mut out = ClaudeUsage::default();
        let today = NaiveDate::from_ymd_opt(2026, 4, 26).unwrap();
        scan_jsonl(&jsonl, today, &mut out);

        let opus = out.all_time.get("claude-opus-4-7").unwrap();
        assert_eq!(opus.input_tokens, 300);
        assert_eq!(opus.output_tokens, 125);
        assert_eq!(opus.cache_read_input_tokens, 1000);

        let sonnet = out.all_time.get("claude-sonnet-4-6").unwrap();
        assert_eq!(sonnet.input_tokens, 10);

        // "Today" only includes the records whose ts is on `today` in LOCAL tz.
        // The first two records are at 2026-04-26 UTC; depending on the test
        // runner's local TZ they may or may not be "today" — so just check
        // sonnet (2025-12-01) is NOT in today.
        assert!(out.today.get("claude-sonnet-4-6").is_none());
    }

    #[test]
    fn skips_zero_token_records() {
        let dir = tempfile::tempdir().unwrap();
        let jsonl = dir.path().join("sess.jsonl");
        // All zeros → should be skipped entirely.
        std::fs::write(
            &jsonl,
            r#"{"type":"assistant","timestamp":"2026-04-26T08:00:00Z","message":{"model":"x","usage":{"input_tokens":0,"output_tokens":0}}}"#,
        )
        .unwrap();
        let mut out = ClaudeUsage::default();
        scan_jsonl(&jsonl, today_local(), &mut out);
        assert!(out.all_time.is_empty());
    }
}
