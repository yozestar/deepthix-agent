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
use std::sync::Mutex;

use chrono::{Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};

/// Public Claude Code OAuth client id — same value used by every
/// open-source claude-usage clone. Extracted from claude code's CLI
/// (it's a public client identifier — refresh still requires the
/// matching refresh_token).
const CLAUDE_CODE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/// In-process cache of the access token. Avoids hammering the keychain
/// (which can prompt) and lets us hold a refreshed token without
/// rewriting the system credential store.
static TOKEN_CACHE: Mutex<Option<CachedToken>> = Mutex::new(None);

#[derive(Clone)]
struct CachedToken {
    access_token: String,
    refresh_token: String,
    /// epoch ms — same convention as the keychain payload.
    expires_at_ms: u64,
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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
// Real subscription limits — undocumented endpoint that claude.ai uses
// for its own "Plan usage limits" panel. Discovered via reverse-engineered
// open-source clones (creaked/claude-usage, JohnDimou/ClaudeWatch, etc.).
//
// The endpoint:
//   GET https://api.anthropic.com/api/oauth/usage
//   Authorization: Bearer <accessToken>
//   anthropic-beta: oauth-2025-04-20
//
// Response shape:
//   {
//     "five_hour":         { "utilization": 0.06, "resets_at": "..." },
//     "seven_day":         { "utilization": 0.01, "resets_at": "..." },
//     "seven_day_sonnet":  { "utilization": 0.00, "resets_at": "..." },
//     "extra_usage":       { ... } // optional, only some plans
//   }
//
// We shell out to `curl` (macOS-only app, curl is part of base install)
// to avoid pulling in a full HTTP crate just for one GET. The Bearer
// token is fetched from the same keychain entry as `read_claude_subscription`.
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct UsageBucket {
    /// 0.0..1.0 fraction of the bucket consumed.
    pub utilization: f64,
    /// ISO-8601 UTC timestamp when this bucket resets. May be empty.
    pub resets_at: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ClaudeUsageLimits {
    /// Current 5h session window. The "Current session" row on claude.ai.
    pub five_hour: UsageBucket,
    /// Weekly all-models bucket.
    pub seven_day: UsageBucket,
    /// Weekly Sonnet-only bucket.
    pub seven_day_sonnet: UsageBucket,
    /// Set when the API returned a non-2xx so the UI can render an error.
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct UsageBucketRaw {
    #[serde(default)]
    utilization: Option<f64>,
    #[serde(default)]
    resets_at: Option<String>,
}

#[derive(Deserialize)]
struct UsageResponseRaw {
    #[serde(default)]
    five_hour: Option<UsageBucketRaw>,
    #[serde(default)]
    seven_day: Option<UsageBucketRaw>,
    #[serde(default)]
    seven_day_sonnet: Option<UsageBucketRaw>,
}

fn bucket_from(raw: Option<UsageBucketRaw>) -> UsageBucket {
    let raw = raw.unwrap_or(UsageBucketRaw {
        utilization: None,
        resets_at: None,
    });
    UsageBucket {
        utilization: raw.utilization.unwrap_or(0.0),
        resets_at: raw.resets_at.unwrap_or_default(),
    }
}

/// Read access + refresh + expiry from the keychain payload. None if
/// not signed in.
fn read_keychain_tokens() -> Option<CachedToken> {
    let output = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let oauth = parsed.get("claudeAiOauth")?;
    Some(CachedToken {
        access_token: oauth.get("accessToken")?.as_str()?.to_string(),
        refresh_token: oauth
            .get("refreshToken")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        expires_at_ms: oauth
            .get("expiresAt")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

/// Hit the OAuth token endpoint with the refresh token to get a fresh
/// access token. Returns the new {access, refresh, expires_at} on
/// success; the response includes a rotated refresh token that we
/// stash in the cache for next time.
fn refresh_access_token(refresh_token: &str) -> Result<CachedToken, String> {
    if refresh_token.is_empty() {
        return Err("no refresh_token available".to_string());
    }
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLAUDE_CODE_CLIENT_ID,
    })
    .to_string();

    let output = Command::new("curl")
        .args([
            "--silent",
            "--max-time",
            "8",
            "--write-out",
            "\n%{http_code}",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-d",
            &body,
            "https://console.anthropic.com/v1/oauth/token",
        ])
        .output()
        .map_err(|e| format!("curl spawn (refresh) failed: {e}"))?;
    let combined = String::from_utf8_lossy(&output.stdout).into_owned();
    let (resp_body, status) = match combined.rfind('\n') {
        Some(idx) => (
            combined[..idx].to_string(),
            combined[idx + 1..].trim().to_string(),
        ),
        None => (combined.clone(), "000".to_string()),
    };
    let status_num: u16 = status.parse().unwrap_or(0);
    if !(200..300).contains(&status_num) {
        return Err(format!("refresh HTTP {status} — {}", resp_body.chars().take(200).collect::<String>()));
    }

    #[derive(Deserialize)]
    struct RefreshResponse {
        access_token: String,
        #[serde(default)]
        refresh_token: Option<String>,
        #[serde(default)]
        expires_in: Option<u64>,
    }
    let parsed: RefreshResponse = serde_json::from_str(&resp_body)
        .map_err(|e| format!("parse refresh response: {e} (body={resp_body})"))?;
    let expires_at_ms =
        now_ms() + parsed.expires_in.unwrap_or(3600).saturating_mul(1000);
    Ok(CachedToken {
        access_token: parsed.access_token,
        // Refresh tokens may rotate; keep the new one if returned, else
        // re-use the existing one for the next refresh.
        refresh_token: parsed.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
        expires_at_ms,
    })
}

/// Get a valid (non-expired) access token. Tries in order:
///   1. RAM cache, if not expired.
///   2. Keychain, if not expired (and update RAM cache).
///   3. Refresh via the keychain's refresh_token; cache result.
///
/// We treat tokens as expired 60s BEFORE their stated expiry to avoid
/// the boundary case where claude rotates the keychain entry between
/// our read and the API call.
fn current_access_token() -> Result<String, String> {
    let cushion_ms: u64 = 60_000;
    let now = now_ms();

    if let Some(cached) = TOKEN_CACHE.lock().unwrap().clone() {
        if cached.expires_at_ms > now + cushion_ms {
            return Ok(cached.access_token);
        }
    }

    let keychain = read_keychain_tokens().ok_or_else(|| "no claude credentials in keychain".to_string())?;
    if keychain.expires_at_ms > now + cushion_ms {
        // Keychain token is fresh — cache + use it.
        let token = keychain.access_token.clone();
        *TOKEN_CACHE.lock().unwrap() = Some(keychain);
        return Ok(token);
    }

    // Keychain stale → refresh.
    tracing::info!(
        target: "deepthix::commands",
        keychain_age_min = (now.saturating_sub(keychain.expires_at_ms)) / 60_000,
        "claude oauth token expired; refreshing",
    );
    let fresh = refresh_access_token(&keychain.refresh_token)?;
    let token = fresh.access_token.clone();
    *TOKEN_CACHE.lock().unwrap() = Some(fresh);
    Ok(token)
}

/// One GET attempt against the usage endpoint with the supplied token.
/// Returns Ok((status_code, body)) so the caller can inspect 401 and
/// decide to refresh + retry without conflating it with curl failures.
fn fetch_usage_with(token: &str) -> Result<(u16, String), String> {
    let output = Command::new("curl")
        .args([
            "--silent",
            "--max-time",
            "8",
            "--write-out",
            "\n%{http_code}",
            "-H",
            &format!("Authorization: Bearer {token}"),
            "-H",
            "anthropic-beta: oauth-2025-04-20",
            "-H",
            "Content-Type: application/json",
            "https://api.anthropic.com/api/oauth/usage",
        ])
        .output()
        .map_err(|e| format!("curl spawn failed: {e}"))?;
    let combined = String::from_utf8_lossy(&output.stdout).into_owned();
    let (body, status) = match combined.rfind('\n') {
        Some(idx) => (combined[..idx].to_string(), combined[idx + 1..].trim().to_string()),
        None => (combined.clone(), "000".to_string()),
    };
    let status_num: u16 = status.parse().unwrap_or(0);
    Ok((status_num, body))
}

#[tauri::command]
pub fn read_claude_usage_limits() -> Result<ClaudeUsageLimits, String> {
    let token = match current_access_token() {
        Ok(t) => t,
        Err(e) => {
            return Ok(ClaudeUsageLimits {
                error: Some(e),
                ..Default::default()
            });
        }
    };

    let (status, body) = match fetch_usage_with(&token) {
        Ok(r) => r,
        Err(e) => {
            return Ok(ClaudeUsageLimits {
                error: Some(e),
                ..Default::default()
            });
        }
    };

    // 401 → cached token went stale between cache check and fetch (or
    // anthropic invalidated it). Force a refresh and retry exactly once.
    let (status, body) = if status == 401 {
        tracing::info!(target: "deepthix::commands", "usage 401 — invalidating cache + retrying");
        *TOKEN_CACHE.lock().unwrap() = None;
        match current_access_token() {
            Ok(t) => match fetch_usage_with(&t) {
                Ok(r) => r,
                Err(e) => return Ok(ClaudeUsageLimits {
                    error: Some(e),
                    ..Default::default()
                }),
            },
            Err(e) => {
                return Ok(ClaudeUsageLimits {
                    error: Some(format!("refresh after 401: {e}")),
                    ..Default::default()
                });
            }
        }
    } else {
        (status, body)
    };

    if !(200..300).contains(&status) {
        tracing::warn!(
            target: "deepthix::commands",
            %status, %body,
            "read_claude_usage_limits non-2xx",
        );
        return Ok(ClaudeUsageLimits {
            error: Some(format!("HTTP {status} — {}", body.chars().take(200).collect::<String>())),
            ..Default::default()
        });
    }

    let raw: UsageResponseRaw = serde_json::from_str(&body)
        .map_err(|e| format!("parse usage response: {e} (body={body})"))?;

    let limits = ClaudeUsageLimits {
        five_hour: bucket_from(raw.five_hour),
        seven_day: bucket_from(raw.seven_day),
        seven_day_sonnet: bucket_from(raw.seven_day_sonnet),
        error: None,
    };
    tracing::info!(
        target: "deepthix::commands",
        five_hour = limits.five_hour.utilization,
        seven_day = limits.seven_day.utilization,
        sonnet = limits.seven_day_sonnet.utilization,
        "read_claude_usage_limits ok",
    );
    Ok(limits)
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
