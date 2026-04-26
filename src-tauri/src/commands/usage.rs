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
use std::process::Command;

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

// ─────────────────────────────────────────────────────────────────────────
// Subscription info — read from the macOS keychain entry claude code stores.
// Anthropic doesn't expose a usage-limits API to OAuth subscribers, so we
// can only surface the subscription tier name + a link to claude.ai for
// detailed limits. (See sibling command `read_claude_daily_activity`
// for what we CAN show locally.)
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ClaudeSubscription {
    /// e.g. "max", "pro", "free". Empty if we can't read the keychain.
    pub subscription_type: String,
    /// e.g. "default_claude_max_20x". Empty if absent.
    pub rate_limit_tier: String,
    /// True iff we successfully read + parsed the keychain entry.
    pub authenticated: bool,
}

#[derive(Deserialize)]
struct KeychainPayload {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<OauthBlock>,
}

#[derive(Deserialize)]
struct OauthBlock {
    #[serde(rename = "subscriptionType", default)]
    subscription_type: Option<String>,
    #[serde(rename = "rateLimitTier", default)]
    rate_limit_tier: Option<String>,
}

#[tauri::command]
pub fn read_claude_subscription() -> Result<ClaudeSubscription, String> {
    // `security find-generic-password -s "Claude Code-credentials" -w` prints
    // ONLY the password value (the JSON blob) on stdout. We parse it for
    // the subscription metadata. macOS-only — fine since the whole app is.
    let output = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|e| format!("security spawn failed: {e}"))?;
    if !output.status.success() {
        // Not authed → return empty/unauthenticated rather than error
        // so the UI can show a sane "not signed in" placeholder.
        tracing::debug!(target: "deepthix::commands", "no Claude Code keychain entry");
        return Ok(ClaudeSubscription::default());
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parsed: KeychainPayload = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(target: "deepthix::commands", error = %e, "parse keychain payload");
            return Ok(ClaudeSubscription::default());
        }
    };
    let oauth = parsed.claude_ai_oauth.unwrap_or(OauthBlock {
        subscription_type: None,
        rate_limit_tier: None,
    });
    Ok(ClaudeSubscription {
        subscription_type: oauth.subscription_type.unwrap_or_default(),
        rate_limit_tier: oauth.rate_limit_tier.unwrap_or_default(),
        authenticated: true,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// Daily activity — claude code maintains ~/.claude/stats-cache.json with
// {date, messageCount, sessionCount, toolCallCount} per day.
// Lightly stale (claude only refreshes it occasionally) but it's the
// most accurate per-day picture we can get without the API.
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct DailyActivity {
    pub date: String,
    pub message_count: u64,
    pub session_count: u64,
    pub tool_call_count: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ClaudeActivity {
    /// Today's bucket if present, else zeros.
    pub today: DailyActivity,
    /// Sum of every day's bucket — all-time totals.
    pub all_time: DailyActivity,
    /// Date claude last refreshed the cache (yyyy-mm-dd).
    pub last_computed_date: String,
}

#[derive(Deserialize)]
struct StatsCache {
    #[serde(rename = "lastComputedDate", default)]
    last_computed_date: Option<String>,
    #[serde(rename = "dailyActivity", default)]
    daily_activity: Vec<DailyActivityRaw>,
}

#[derive(Deserialize)]
struct DailyActivityRaw {
    date: String,
    #[serde(rename = "messageCount", default)]
    message_count: u64,
    #[serde(rename = "sessionCount", default)]
    session_count: u64,
    #[serde(rename = "toolCallCount", default)]
    tool_call_count: u64,
}

#[tauri::command]
pub fn read_claude_daily_activity() -> Result<ClaudeActivity, String> {
    let path = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("stats-cache.json"),
        None => return Err("no home dir".to_string()),
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ClaudeActivity::default());
        }
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let cache: StatsCache = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target: "deepthix::commands", error = %e, "parse stats-cache.json");
            return Ok(ClaudeActivity::default());
        }
    };
    let today_iso = today_local().format("%Y-%m-%d").to_string();
    let mut today = DailyActivity {
        date: today_iso.clone(),
        ..Default::default()
    };
    let mut all_time = DailyActivity::default();
    for d in &cache.daily_activity {
        all_time.message_count += d.message_count;
        all_time.session_count += d.session_count;
        all_time.tool_call_count += d.tool_call_count;
        if d.date == today_iso {
            today.message_count = d.message_count;
            today.session_count = d.session_count;
            today.tool_call_count = d.tool_call_count;
        }
    }
    Ok(ClaudeActivity {
        today,
        all_time,
        last_computed_date: cache.last_computed_date.unwrap_or_default(),
    })
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
