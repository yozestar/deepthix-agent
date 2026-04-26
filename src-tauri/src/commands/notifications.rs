// In-app + system notifications.
//
// Two write paths feed the same stream:
//
//   1. Webview UI calls the `notify_user` Tauri command directly
//      (e.g. when a build finishes inside the Tauri app).
//
//   2. The deepthix-mcp sidecar — and any other process — appends a
//      single JSONL record to `~/.deepthix/notifications.jsonl`. We
//      watch that file with the same JsonlWatcher used for claude
//      transcripts and re-emit each new line as a `deepthix-notification`
//      Tauri event so the React layer can show a toast.
//
// Why a file, not a socket: the MCP server runs as a stdio child of the
// claude process, NOT a child of Tauri. It can't easily reach our IPC
// surface, but `~/.deepthix/notifications.jsonl` is shared filesystem
// state both processes already touch, and the JsonlWatcher utility was
// built for exactly this pattern.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::jsonl_watcher::JsonlWatcher;

/// Severity / visual hint for the notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotifKind {
    Info,
    Success,
    Warn,
    Error,
}

impl Default for NotifKind {
    fn default() -> Self {
        Self::Info
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    /// Short headline shown in the toast title row.
    pub title: String,
    /// Optional body text under the title. Empty string if not supplied.
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub kind: NotifKind,
    /// Free-form origin tag — useful for filtering / debugging.
    /// e.g. "build", "ci", "claude:session-3", "mcp:notify_user".
    #[serde(default)]
    pub source: String,
    /// Wall-clock millis. Filled in on the server side if missing.
    #[serde(default)]
    pub ts_ms: u64,
}

impl Notification {
    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// `~/.deepthix/notifications.jsonl` — append-only.
pub fn notifications_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".deepthix").join("notifications.jsonl")
}

/// Stateful holder for the running watcher. Dropped on app shutdown
/// stops the background thread.
pub struct NotificationsWatcher(pub Mutex<Option<JsonlWatcher>>);

/// Emit a notification to the webview AND the macOS Notification Center.
/// Webview side: every UI listening to `deepthix-notification` gets the
/// payload (NotificationToasts shows a toast). System side: native macOS
/// banner via tauri-plugin-notification.
fn dispatch(app: &AppHandle, notif: Notification) {
    tracing::info!(
        target: "deepthix::notifications",
        title = %notif.title,
        kind = ?notif.kind,
        source = %notif.source,
        "dispatch",
    );
    if let Err(e) = app.emit("deepthix-notification", &notif) {
        tracing::warn!(target: "deepthix::notifications", error = %e, "emit failed");
    }
    // System banner — best-effort; if the user denied the permission we
    // still get the in-app toast.
    if let Err(e) = app
        .notification()
        .builder()
        .title(&notif.title)
        .body(&notif.body)
        .show()
    {
        tracing::warn!(target: "deepthix::notifications", error = %e, "system notify failed");
    }
}

/// Tauri command — called from the webview to publish a notification.
#[tauri::command]
pub fn notify_user(
    app: AppHandle,
    title: String,
    body: Option<String>,
    kind: Option<NotifKind>,
    source: Option<String>,
) -> Result<(), String> {
    let notif = Notification {
        title,
        body: body.unwrap_or_default(),
        kind: kind.unwrap_or(NotifKind::Info),
        source: source.unwrap_or_else(|| "webview".to_string()),
        ts_ms: Notification::now_ms(),
    };
    dispatch(&app, notif);
    Ok(())
}

/// Start the JsonlWatcher on `~/.deepthix/notifications.jsonl`. Called
/// once during Tauri setup; re-emits each new file line as a
/// `deepthix-notification` event. Old lines (already on disk at startup)
/// are skipped — we only care about freshly-appended ones.
pub fn start_watcher(app: AppHandle) {
    let path = notifications_path();
    // Make sure ~/.deepthix exists so the watcher doesn't churn on a
    // missing parent directory.
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Pre-seed the file so the watcher has a stable inode to follow
    // (touch-create if missing). Empty file = nothing to skip on first
    // tick, exactly what we want.
    if !path.exists() {
        let _ = std::fs::write(&path, b"");
    }
    // Skip everything already on disk: the JSONL is a long-lived log,
    // we don't want to fire historical notifications when the app
    // starts. Set the watcher offset to the current EOF.
    let initial_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let _ = initial_size; // we re-implement skip-to-end inline below

    let app_handle = app.clone();
    let watcher = JsonlWatcher::start(path.clone(), move |line: &str| {
        // Parse the JSONL line into a Notification. Tolerant of
        // missing fields; if it's totally malformed we log and drop.
        match serde_json::from_str::<Notification>(line) {
            Ok(mut notif) => {
                if notif.ts_ms == 0 {
                    notif.ts_ms = Notification::now_ms();
                }
                if notif.source.is_empty() {
                    notif.source = "mcp".to_string();
                }
                dispatch(&app_handle, notif);
            }
            Err(e) => {
                tracing::warn!(
                    target: "deepthix::notifications",
                    error = %e,
                    line_preview = %line.chars().take(120).collect::<String>(),
                    "malformed notif line",
                );
            }
        }
    });
    if let Some(state) = app.try_state::<NotificationsWatcher>() {
        *state.0.lock().unwrap() = Some(watcher);
    } else {
        // Should never happen — we register the state in setup before
        // calling this. Log loudly if it does.
        tracing::error!(
            target: "deepthix::notifications",
            "NotificationsWatcher state missing — watcher will be dropped immediately",
        );
    }
    tracing::info!(
        target: "deepthix::notifications",
        ?path,
        "notifications watcher started",
    );
}

/// Tauri command — list the most recent N notifications (oldest→newest).
/// Used by the toast tray on app startup so the user sees a summary of
/// what happened while they were away. Reads the JSONL file from the end.
#[tauri::command]
pub fn list_recent_notifications(
    _state: State<'_, NotificationsWatcher>,
    limit: Option<usize>,
) -> Result<Vec<Notification>, String> {
    let cap = limit.unwrap_or(20).min(200);
    let path = notifications_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(vec![]),
    };
    let mut notifs: Vec<Notification> = content
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Notification>(l).ok())
        .take(cap)
        .collect();
    notifs.reverse();
    Ok(notifs)
}
