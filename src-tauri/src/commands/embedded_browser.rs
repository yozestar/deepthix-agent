//! Embed Google Chrome as an overlay window above the Tauri main window.
//!
//! Tauri uses WKWebView on macOS, which means we cannot natively embed
//! Chromium inside our window. Instead we spawn the user's real Chrome in
//! `--app=URL` mode (chrome-less app window) and reposition that window via
//! AppleScript every time the parent moves/resizes/scrolls. From the user's
//! perspective this looks like Chrome is "embedded" inside Deepthix's
//! BROWSER tab.
//!
//! ## Why AppleScript and not `addChildWindow:` ?
//!
//! `[NSWindow addChildWindow:ordered:]` would auto-track parent moves and
//! avoid the small lag we get with osascript. But cross-process NSWindow
//! manipulation requires either the Accessibility API (and a permission
//! prompt) or low-level CoreGraphics + objc2 plumbing. AppleScript control
//! of Chrome only requires the user to grant Automation permission once
//! (the same permission needed to drive Chrome from any script). That keeps
//! the implementation small and the UX similar enough — drag lag is ~16-50ms
//! during fast motions, otherwise imperceptible.
//!
//! ## Lifecycle
//!
//! 1. `spawn_embedded_browser(url, x, y, w, h)` — spawn Chrome via `open -na`
//!    with the URL as the app, the requested geometry, and a per-instance
//!    user-data-dir (or the user's default profile if `useProfile=true`).
//!    Poll `osascript` for up to ~3s waiting for a window matching the
//!    spawned PID + URL to appear; once found, store the window id in our
//!    in-memory registry and return a string id to the caller.
//!
//! 2. `position_embedded_browser(id, x, y, w, h)` — `set bounds of window …`
//!    via AppleScript. Coordinates come from the frontend in screen-space
//!    logical points (top-left origin), exactly what AppleScript expects.
//!
//! 3. `hide_embedded_browser(id)` / `show_embedded_browser(id)` — set
//!    `visible` of the window. macOS hides Chrome's app window completely;
//!    `show` brings it back at its previous position.
//!
//! 4. `close_embedded_browser(id)` — kill the Chrome PID, remove the entry
//!    from the registry, and best-effort wipe the per-instance profile dir.
//!
//! All commands are heavily logged so stuck states are easy to diagnose.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

/// One spawned Chrome instance we are tracking.
#[derive(Debug, Clone)]
struct BrowserHandle {
    /// PID of the spawned Chrome helper. We use this both for `kill` and to
    /// constrain AppleScript searches via `id of front window` after spawn.
    pid: i32,
    /// Window id from AppleScript (`id of window …`). Stable for a given
    /// window; this is how we re-target the window after we lose track of
    /// titles or tab switches.
    window_id: i64,
    /// URL we asked Chrome to open. Used as the matcher when probing for
    /// the window during `spawn_embedded_browser`.
    url: String,
    /// Per-instance profile dir, only set when we created one (i.e. when
    /// the caller did NOT use the user's default Chrome profile).
    profile_dir: Option<PathBuf>,
}

/// Mutex-guarded registry. Lives in `app.manage()`.
#[derive(Default)]
pub struct EmbeddedBrowserRegistry {
    inner: Mutex<HashMap<String, BrowserHandle>>,
}

impl EmbeddedBrowserRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Returned to JS so subsequent calls can address this Chrome instance.
#[derive(Debug, Serialize, Deserialize)]
pub struct EmbeddedBrowserSpawn {
    pub id: String,
    pub pid: i32,
    pub window_id: i64,
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/// Run an osascript snippet and return stdout. Errors include stderr for
/// debugging — Chrome's AppleScript errors are usually self-explanatory
/// ("System Events got an error: …").
fn run_osascript(script: &str) -> Result<String, String> {
    tracing::debug!(target: "deepthix::embedded_browser", script = %script.replace('\n', " | "), "osascript");
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| {
            tracing::error!(target: "deepthix::embedded_browser", error = %e, "osascript spawn failed");
            format!("Failed to run osascript: {e}")
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::warn!(
            target: "deepthix::embedded_browser",
            code = ?output.status.code(),
            stderr = %stderr,
            "osascript exited non-zero"
        );
        return Err(format!(
            "osascript failed (status {:?}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    tracing::debug!(target: "deepthix::embedded_browser", stdout = %stdout, "osascript ok");
    Ok(stdout)
}

/// Find the Chrome window id whose URL matches `url` AND whose owning Chrome
/// process group includes `pid`. AppleScript can't easily filter by PID per
/// window since Chrome's Helper processes don't host windows directly — the
/// browser process owns them. We rely on URL match instead, which is fine
/// because we just spawned this URL and Chrome's `--app=URL` opens a fresh
/// window for it.
///
/// Returns `Some(window_id)` if found.
fn find_chrome_window_by_url(url: &str) -> Result<Option<i64>, String> {
    // AppleScript: iterate all Chrome windows, return id of the first one
    // whose active tab URL matches. We compare with `starts with` because
    // Chrome may add a trailing `/` or normalize the URL slightly.
    //
    // Wrap in a try block so we get a clean error if Chrome isn't running
    // yet (the very first launch may not have registered with osascript
    // immediately).
    let needle = url.replace('"', "\\\"");
    let script = format!(
        r#"
try
  tell application "Google Chrome"
    set foundId to 0
    repeat with w in windows
      try
        set tabUrl to URL of active tab of w as string
        if tabUrl is "{needle}" or tabUrl starts with "{needle}" then
          set foundId to id of w
          exit repeat
        end if
      end try
    end repeat
    return foundId as string
  end tell
on error errMsg
  return "0"
end try
"#
    );
    let raw = run_osascript(&script)?;
    let parsed: i64 = raw.parse().map_err(|e| {
        format!("Could not parse Chrome window id from osascript output {raw:?}: {e}")
    })?;
    if parsed == 0 {
        Ok(None)
    } else {
        Ok(Some(parsed))
    }
}

/// Build the unique per-instance profile dir under `~/.deepthix/chrome-profiles/<uuid>`.
fn make_profile_dir(uuid: &str) -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    let dir = home.join(".deepthix").join("chrome-profiles").join(uuid);
    std::fs::create_dir_all(&dir).map_err(|e| {
        format!("Failed to create Chrome profile dir {}: {e}", dir.display())
    })?;
    Ok(dir)
}

// ─────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────

/// Spawn a real Chrome window in `--app=URL` mode, sized + positioned to
/// `(x, y, width, height)` in screen-space logical pixels (top-left origin).
///
/// `use_profile=true` (default from caller) launches Chrome with the user's
/// default profile so extensions like claude-in-chrome MCP work. `false`
/// creates a fresh per-instance profile dir, which is useful for clean-room
/// testing but loses the user's extensions and cookies.
#[tauri::command]
pub fn spawn_embedded_browser(
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    use_profile: Option<bool>,
    registry: State<'_, EmbeddedBrowserRegistry>,
) -> Result<EmbeddedBrowserSpawn, String> {
    let use_profile = use_profile.unwrap_or(true);
    tracing::info!(
        target: "deepthix::embedded_browser",
        %url, %x, %y, %width, %height, %use_profile,
        "spawn_embedded_browser"
    );

    if url.trim().is_empty() {
        return Err("spawn_embedded_browser: url is empty".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();

    // Build the Chrome args. `--new-window` is important when the user already
    // has a Chrome instance running, otherwise the URL would fold into an
    // existing tab.
    let app_arg = format!("--app={url}");
    let size_arg = format!("--window-size={width},{height}");
    let pos_arg = format!("--window-position={x},{y}");

    let mut cmd = Command::new("open");
    cmd.args(["-na", "Google Chrome", "--args"])
        .arg(&app_arg)
        .arg(&size_arg)
        .arg(&pos_arg)
        .arg("--new-window");

    let profile_dir: Option<PathBuf> = if use_profile {
        // Use the user's existing profile so claude-in-chrome MCP / extensions work.
        None
    } else {
        let dir = make_profile_dir(&id)?;
        cmd.arg(format!("--user-data-dir={}", dir.display()));
        Some(dir)
    };

    tracing::debug!(
        target: "deepthix::embedded_browser",
        ?app_arg, ?size_arg, ?pos_arg, ?profile_dir,
        "spawning Chrome via `open`"
    );

    let status = cmd.status().map_err(|e| {
        tracing::error!(target: "deepthix::embedded_browser", error = %e, "open spawn failed");
        format!("Failed to launch Chrome: {e}")
    })?;
    if !status.success() {
        return Err(format!(
            "`open` exited with status {:?} — is Google Chrome installed?",
            status.code()
        ));
    }

    // `open -na` returns immediately. The Chrome process is now starting up;
    // we poll AppleScript for up to ~3s to find the new window. AppleScript
    // returning a non-zero id confirms Chrome is responsive AND the window
    // exists.
    //
    // We can't easily get the spawned PID from `open` (it returns 0 once it's
    // dispatched the LaunchServices call). Instead we ask the system:
    // `pgrep -n "Google Chrome"` returns the most-recently-started Chrome
    // process. Combined with URL matching above, that's reliable enough for
    // our use case.
    let started = Instant::now();
    let timeout = Duration::from_millis(3_000);
    let mut window_id: Option<i64> = None;
    while started.elapsed() < timeout {
        match find_chrome_window_by_url(&url) {
            Ok(Some(wid)) => {
                window_id = Some(wid);
                break;
            }
            Ok(None) => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                tracing::debug!(
                    target: "deepthix::embedded_browser",
                    error = %e,
                    "find_chrome_window_by_url retrying"
                );
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    }

    let window_id = window_id.ok_or_else(|| {
        tracing::error!(
            target: "deepthix::embedded_browser",
            %url,
            "timed out waiting for Chrome window to appear (3s). Did the user grant Automation permission?"
        );
        // Best-effort cleanup: nuke the profile dir we just created.
        if let Some(d) = &profile_dir {
            let _ = std::fs::remove_dir_all(d);
        }
        format!(
            "Could not locate Chrome window for {url} within 3s. Likely causes: \
             (1) Chrome is not installed at /Applications/Google Chrome.app, \
             (2) the user has not granted Deepthix Automation control of Chrome \
             (System Settings → Privacy & Security → Automation), or \
             (3) the URL was rejected before a window could open."
        )
    })?;

    // Resolve the owning PID via pgrep — best-effort; if it fails we still
    // return success because the window was found and is positioned.
    let pid: i32 = match Command::new("pgrep").args(["-n", "Google Chrome"]).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse()
            .unwrap_or(-1),
        _ => -1,
    };

    let handle = BrowserHandle {
        pid,
        window_id,
        url: url.clone(),
        profile_dir,
    };
    registry
        .inner
        .lock()
        .unwrap()
        .insert(id.clone(), handle);

    tracing::info!(
        target: "deepthix::embedded_browser",
        id = %id, %window_id, %pid,
        "spawn_embedded_browser ok"
    );

    Ok(EmbeddedBrowserSpawn { id, pid, window_id })
}

/// Reposition the embedded Chrome window to `(x, y, width, height)` in
/// screen-space logical pixels. Called on Tauri parent move/resize and on
/// the iframe container's own ResizeObserver.
#[tauri::command]
pub fn position_embedded_browser(
    id: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    registry: State<'_, EmbeddedBrowserRegistry>,
) -> Result<(), String> {
    tracing::debug!(
        target: "deepthix::embedded_browser",
        %id, %x, %y, %width, %height,
        "position_embedded_browser"
    );
    let window_id = {
        let map = registry.inner.lock().unwrap();
        map.get(&id)
            .ok_or_else(|| format!("Unknown embedded browser id: {id}"))?
            .window_id
    };

    // bounds = {left, top, right, bottom} in points, top-left origin.
    let right = x.saturating_add(width as i32);
    let bottom = y.saturating_add(height as i32);
    let script = format!(
        r#"
try
  tell application "Google Chrome"
    set bounds of (first window whose id is {window_id}) to {{ {x}, {y}, {right}, {bottom} }}
  end tell
on error errMsg
  return "ERR:" & errMsg
end try
"#
    );
    let out = run_osascript(&script)?;
    if let Some(err) = out.strip_prefix("ERR:") {
        // The window may have been closed by the user; treat as a soft error.
        tracing::warn!(
            target: "deepthix::embedded_browser",
            %id, %window_id, %err,
            "position_embedded_browser failed inside Chrome"
        );
        return Err(format!("Chrome rejected position: {err}"));
    }
    Ok(())
}

/// Hide the embedded Chrome window (used when the user switches away from
/// the BROWSER tab). Implemented via AppleScript `set visible … to false`,
/// which on Chrome maps to a window minimize-equivalent without losing state.
#[tauri::command]
pub fn hide_embedded_browser(
    id: String,
    registry: State<'_, EmbeddedBrowserRegistry>,
) -> Result<(), String> {
    tracing::info!(target: "deepthix::embedded_browser", %id, "hide_embedded_browser");
    let window_id = {
        let map = registry.inner.lock().unwrap();
        map.get(&id)
            .ok_or_else(|| format!("Unknown embedded browser id: {id}"))?
            .window_id
    };
    let script = format!(
        r#"
try
  tell application "Google Chrome"
    set visible of (first window whose id is {window_id}) to false
  end tell
on error errMsg
  return "ERR:" & errMsg
end try
"#
    );
    let out = run_osascript(&script)?;
    if let Some(err) = out.strip_prefix("ERR:") {
        tracing::warn!(target: "deepthix::embedded_browser", %id, %err, "hide failed");
    }
    Ok(())
}

/// Show the embedded Chrome window after it was hidden. The frontend should
/// follow this with a `position_embedded_browser` call to make sure the
/// window snaps back to the (possibly-moved) iframe area.
#[tauri::command]
pub fn show_embedded_browser(
    id: String,
    registry: State<'_, EmbeddedBrowserRegistry>,
) -> Result<(), String> {
    tracing::info!(target: "deepthix::embedded_browser", %id, "show_embedded_browser");
    let window_id = {
        let map = registry.inner.lock().unwrap();
        map.get(&id)
            .ok_or_else(|| format!("Unknown embedded browser id: {id}"))?
            .window_id
    };
    let script = format!(
        r#"
try
  tell application "Google Chrome"
    set visible of (first window whose id is {window_id}) to true
  end tell
on error errMsg
  return "ERR:" & errMsg
end try
"#
    );
    let out = run_osascript(&script)?;
    if let Some(err) = out.strip_prefix("ERR:") {
        tracing::warn!(target: "deepthix::embedded_browser", %id, %err, "show failed");
    }
    Ok(())
}

/// Close the embedded Chrome window: politely close via AppleScript first,
/// then nuke the per-instance profile dir if we created one. We do NOT
/// `kill -9` the Chrome PID because that may be the user's main Chrome
/// process (when `use_profile=true` we share the user's process).
#[tauri::command]
pub fn close_embedded_browser(
    id: String,
    registry: State<'_, EmbeddedBrowserRegistry>,
) -> Result<(), String> {
    tracing::info!(target: "deepthix::embedded_browser", %id, "close_embedded_browser");
    let handle = {
        let mut map = registry.inner.lock().unwrap();
        map.remove(&id)
    };
    let Some(handle) = handle else {
        return Err(format!("Unknown embedded browser id: {id}"));
    };

    let script = format!(
        r#"
try
  tell application "Google Chrome"
    close (first window whose id is {wid})
  end tell
on error errMsg
  return "ERR:" & errMsg
end try
"#,
        wid = handle.window_id
    );
    if let Err(e) = run_osascript(&script) {
        tracing::warn!(target: "deepthix::embedded_browser", %id, error = %e, "AppleScript close failed");
    }

    // Cleanup the profile dir, if any.
    if let Some(dir) = &handle.profile_dir {
        if let Err(e) = std::fs::remove_dir_all(dir) {
            tracing::warn!(
                target: "deepthix::embedded_browser",
                %id, dir = %dir.display(), error = %e,
                "could not remove per-instance Chrome profile dir"
            );
        }
    }

    tracing::info!(
        target: "deepthix::embedded_browser",
        %id, pid = handle.pid, url = %handle.url,
        "close_embedded_browser ok"
    );
    Ok(())
}
