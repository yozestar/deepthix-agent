//! Embed Google Chrome as an overlay window above the Tauri main window.
//!
//! Tauri uses WKWebView on macOS, which means we cannot natively embed
//! Chromium inside our window. Instead we spawn the user's real Chrome in
//! `--app=URL` mode (chrome-less app window) and reposition that window via
//! AppleScript every time the parent moves/resizes/scrolls. From the user's
//! perspective this looks like Chrome is "embedded" inside Deepthix's
//! BROWSER tab.
//!
//! ## Why not `[NSWindow addChildWindow:ordered:]` ?
//!
//! `addChildWindow:` is exactly what we'd want — an auto-tracked, hide-with-
//! parent, follow-on-drag z-order coupling. Unfortunately it ONLY works for
//! NSWindows that live in the SAME process. Chrome's NSWindow is owned by
//! Chrome's process (different PID, different address space) — there is no
//! API that returns an `NSWindow*` pointer for a window in another process.
//! Apple intentionally forbids this to preserve app-sandbox boundaries.
//!
//! So we emulate the effect with two cooperating tricks (see `zorder` module
//! below). Both are gated on macOS and on having at least one embedded
//! browser active:
//!
//! 1. **Lower Deepthix's `NSWindow.level`** to `NSNormalWindowLevel - 1`
//!    while an embedded browser is open. macOS's window level is an absolute
//!    z-order override: a level-0 window (Chrome's default) is always drawn
//!    above a level-(-1) window (Deepthix), even when Deepthix is the active
//!    app. This gives us the visual stacking we want "for free" from the
//!    compositor — no polling, no lag.
//!
//! 2. **Re-raise Chrome on activation**: when Deepthix becomes the active
//!    app (`NSWorkspaceDidActivateApplicationNotification`), we fire an
//!    AppleScript `tell application "Google Chrome" to activate` so Chrome
//!    is brought above whatever other app was in front, and re-activate
//!    ourselves via System Events so keyboard focus returns to Deepthix.
//!    The window-level override from (1) then keeps Chrome visually on top.
//!
//! The combination gives: Chrome visible above Deepthix's browser pane while
//! Deepthix retains keyboard focus, survives Deepthix drags and minimizes,
//! and restores cleanly when the embedded browser closes.
//!
//! ### Known limitation
//!
//! While Deepthix's window level is sub-normal, any OTHER non-active app's
//! window at level 0 (normal) that overlaps Deepthix will also draw above
//! Deepthix. In practice, users running Deepthix's BROWSER mode have it as
//! their focal app and don't have other windows overlapping the browser
//! pane, so this is a non-issue. If we ever need true isolation, CEF is the
//! only real answer.
//!
//! ## Lifecycle
//!
//! 1. `spawn_embedded_browser(url, x, y, w, h)` — spawn Chrome via `open -na`
//!    with the URL as the app, the requested geometry, and a per-instance
//!    user-data-dir (or the user's default profile if `useProfile=true`).
//!    Poll `osascript` for up to ~3s waiting for a window matching the
//!    spawned PID + URL to appear; once found, store the window id in our
//!    in-memory registry and return a string id to the caller. On macOS,
//!    the first spawn also installs the z-order coupling (observer + window
//!    level demotion); close of the last embedded browser restores it.
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
use tauri::{AppHandle, State};

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
#[allow(clippy::too_many_arguments)] // Tauri commands take whatever the JS caller passes — splitting these would just push the boilerplate elsewhere.
pub fn spawn_embedded_browser(
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    use_profile: Option<bool>,
    app: AppHandle,
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
    let new_count = {
        let mut map = registry.inner.lock().unwrap();
        map.insert(id.clone(), handle);
        map.len()
    };

    // First embedded browser → install the z-order coupling (lower Deepthix
    // window level + start the activation observer). On subsequent spawns
    // this is a no-op because we keep the level lowered until the LAST
    // embedded browser closes.
    #[cfg(target_os = "macos")]
    {
        if new_count == 1 {
            tracing::info!(
                target: "deepthix::embedded_browser",
                "first embedded browser — engaging z-order coupling"
            );
            zorder::engage(&app);
        } else {
            tracing::debug!(
                target: "deepthix::embedded_browser",
                count = new_count,
                "z-order already engaged"
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, new_count); // suppress unused warnings on non-mac builds
    }

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
    app: AppHandle,
    registry: State<'_, EmbeddedBrowserRegistry>,
) -> Result<(), String> {
    tracing::info!(target: "deepthix::embedded_browser", %id, "close_embedded_browser");
    let (handle, remaining) = {
        let mut map = registry.inner.lock().unwrap();
        let h = map.remove(&id);
        (h, map.len())
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

    // If that was the last embedded browser, restore Deepthix's normal window
    // level so the rest of the app behaves like a regular macOS window again.
    #[cfg(target_os = "macos")]
    {
        if remaining == 0 {
            tracing::info!(
                target: "deepthix::embedded_browser",
                "last embedded browser closed — disengaging z-order coupling"
            );
            zorder::disengage(&app);
        } else {
            tracing::debug!(
                target: "deepthix::embedded_browser",
                count = remaining,
                "other embedded browsers still active — leaving z-order engaged"
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, remaining); // suppress unused warnings on non-mac builds
    }

    tracing::info!(
        target: "deepthix::embedded_browser",
        %id, pid = handle.pid, url = %handle.url,
        "close_embedded_browser ok"
    );
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// macOS z-order coupling
// ─────────────────────────────────────────────────────────────────────────

/// Cross-process z-order coupling for the embedded Chrome trick.
///
/// See the module-level docs for the full design. Briefly:
///
/// - On `engage`: lower Deepthix's main window level to one below normal so
///   Chrome (level 0) always draws above us, then install a one-time
///   `NSWorkspaceDidActivateApplicationNotification` observer that re-raises
///   Chrome and re-focuses Deepthix whenever Deepthix becomes the active
///   app. The observer is global and self-gating — it only acts when an
///   embedded browser is currently registered.
///
/// - On `disengage`: raise Deepthix's window level back to normal. We leave
///   the notification observer registered (it's cheap and harmless to keep
///   around — it checks the registry on every tick); installing only once
///   per app boot avoids any chance of duplicate observers piling up if the
///   user opens & closes the BROWSER pane many times.
#[cfg(target_os = "macos")]
mod zorder {
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSRunningApplication, NSWindow, NSWindowLevel, NSWorkspace, NSWorkspaceApplicationKey,
        NSWorkspaceDidActivateApplicationNotification,
    };
    use objc2_foundation::NSNotification;
    use tauri::{AppHandle, Manager};

    /// We install the activation observer at most once per process boot.
    static OBSERVER_INSTALLED: AtomicBool = AtomicBool::new(false);

    /// Set to `true` while at least one embedded browser is active. The
    /// activation observer reads this and is a no-op when false. Mirrors
    /// `EmbeddedBrowserRegistry.len() > 0` from outside the registry's lock
    /// so the observer never has to acquire it.
    static COUPLING_ACTIVE: AtomicBool = AtomicBool::new(false);

    /// Cached PID of our own process. Used by the activation observer to
    /// decide whether the activated app is us. Cheaper than fetching the
    /// bundle id every tick.
    static OUR_PID: OnceLock<i32> = OnceLock::new();

    fn our_pid() -> i32 {
        *OUR_PID.get_or_init(|| std::process::id() as i32)
    }

    /// Lower Deepthix's main window level + arm the activation observer.
    pub fn engage(app: &AppHandle) {
        COUPLING_ACTIVE.store(true, Ordering::SeqCst);
        if let Err(e) = set_main_window_level(app, sub_normal_level()) {
            tracing::warn!(
                target: "deepthix::embedded_browser",
                error = %e,
                "could not lower Deepthix window level"
            );
        }
        install_observer_once();
        // Trigger the re-raise immediately so Chrome is in front from the
        // very first frame the user sees, instead of waiting for the next
        // app-activation event.
        reraise_chrome_then_self();
    }

    /// Restore Deepthix's main window level to normal. The observer remains
    /// installed but becomes a no-op via `COUPLING_ACTIVE`.
    pub fn disengage(app: &AppHandle) {
        COUPLING_ACTIVE.store(false, Ordering::SeqCst);
        if let Err(e) = set_main_window_level(app, normal_level()) {
            tracing::warn!(
                target: "deepthix::embedded_browser",
                error = %e,
                "could not restore Deepthix window level"
            );
        }
    }

    /// `NSNormalWindowLevel = 0`. Hard-coded because objc2-app-kit exposes
    /// these as `NSWindowLevel` integers; we don't want a feature gate
    /// dependency on the constants module.
    fn normal_level() -> NSWindowLevel {
        0 as NSWindowLevel
    }

    /// One step below normal. macOS treats window level as the dominant
    /// axis for stacking — a normal-level window from any app will draw
    /// above a sub-normal window even when the sub-normal app is active.
    fn sub_normal_level() -> NSWindowLevel {
        -1 as NSWindowLevel
    }

    /// Set the level on Deepthix's main window. Must run on the main thread.
    fn set_main_window_level(app: &AppHandle, level: NSWindowLevel) -> Result<(), String> {
        // Tauri exposes the underlying NSWindow via `WebviewWindow::ns_window`.
        // We grab the main window (the only one Deepthix has). The pointer
        // returned is a non-owning `*mut c_void` to the NSWindow.
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "no `main` webview window".to_string())?;

        // ns_window() returns Result<*mut c_void, _> with the raw NSWindow
        // pointer. We must touch AppKit on the main thread.
        let raw = window
            .ns_window()
            .map_err(|e| format!("ns_window() failed: {e}"))?;
        if raw.is_null() {
            return Err("ns_window returned null".to_string());
        }

        // Hop to the main thread. Tauri's `run_on_main_thread` runs the
        // closure on the AppKit main thread, where it's safe to mutate
        // NSWindow state.
        let raw_addr = raw as usize;
        let level_val = level;
        app.run_on_main_thread(move || {
            // SAFETY: raw_addr was a valid `*mut NSWindow` at the time we
            // captured it. NSWindow lives for the whole app lifetime (it's
            // owned by the AppKit window list), so the pointer remains
            // valid here. We only touch it on the main thread.
            unsafe {
                let ptr = raw_addr as *mut NSWindow;
                let nswin: &NSWindow = &*ptr;
                nswin.setLevel(level_val);
            }
            tracing::debug!(
                target: "deepthix::embedded_browser",
                level = level_val,
                "Deepthix main NSWindow level set"
            );
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;
        Ok(())
    }

    /// Install the global `NSWorkspaceDidActivateApplicationNotification`
    /// observer. Idempotent — only the first call actually subscribes.
    fn install_observer_once() {
        if OBSERVER_INSTALLED.swap(true, Ordering::SeqCst) {
            return;
        }
        // Install on the main thread so AppKit doesn't yell at us.
        std::thread::spawn(|| {
            // We can't dispatch to the AppKit main thread from arbitrary
            // Rust code without an AppHandle. But NSWorkspace's notification
            // center is thread-safe to subscribe to, and the block we pass
            // is invoked on the main thread by the notification system, so
            // doing it from this thread is fine.
            unsafe {
                let workspace = NSWorkspace::sharedWorkspace();
                let center = workspace.notificationCenter();

                let block = RcBlock::new(move |notif: NonNull<NSNotification>| {
                    handle_did_activate(notif);
                });

                // We pass NULL for object (= subscribe to ALL senders) and
                // NULL for queue (= invoke synchronously on the posting
                // thread, which is the main thread for NSWorkspace).
                let _token = center.addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceDidActivateApplicationNotification),
                    None,
                    None,
                    &block,
                );
                // We intentionally leak `_token` — we never want to remove
                // this observer, it lives for the app's whole lifetime.
                std::mem::forget(_token);
            }
            tracing::info!(
                target: "deepthix::embedded_browser",
                "NSWorkspaceDidActivateApplicationNotification observer installed"
            );
        });
    }

    /// Notification callback. Runs on the main thread (NSWorkspace posts on
    /// the main thread). Decides whether the activated app is us, and if so
    /// re-raises Chrome then re-focuses Deepthix.
    fn handle_did_activate(notif: NonNull<NSNotification>) {
        // Cheap early-out: when no embedded browser is active, do nothing.
        if !COUPLING_ACTIVE.load(Ordering::SeqCst) {
            return;
        }

        // SAFETY: the notification reference is valid for the duration of
        // this call (NSNotificationCenter contracts).
        let activated_pid = unsafe {
            let notif_ref: &NSNotification = notif.as_ref();
            let user_info = match notif_ref.userInfo() {
                Some(d) => d,
                None => {
                    tracing::debug!(target: "deepthix::embedded_browser", "didActivate without userInfo");
                    return;
                }
            };
            // The userInfo dict holds the activated NSRunningApplication
            // under NSWorkspaceApplicationKey.
            let key: &objc2_foundation::NSString = NSWorkspaceApplicationKey;
            let any: Option<Retained<AnyObject>> =
                user_info.objectForKey(key.as_ref() as &AnyObject);
            let Some(any) = any else {
                tracing::debug!(target: "deepthix::embedded_browser", "no NSWorkspaceApplicationKey in userInfo");
                return;
            };
            // Cast to NSRunningApplication and read its PID.
            let app_ptr = Retained::as_ptr(&any) as *const NSRunningApplication;
            let app_ref: &NSRunningApplication = &*app_ptr;
            app_ref.processIdentifier()
        };

        let our = our_pid();
        if activated_pid != our {
            tracing::trace!(
                target: "deepthix::embedded_browser",
                activated = activated_pid,
                ours = our,
                "didActivate from a different app — ignoring"
            );
            return;
        }

        tracing::debug!(
            target: "deepthix::embedded_browser",
            "Deepthix activated — re-raising Chrome"
        );
        reraise_chrome_then_self();
    }

    /// Fire the AppleScript that brings Chrome above Deepthix in z-order
    /// then re-asserts focus on Deepthix. Runs in a background thread so we
    /// never block AppKit's main thread on osascript.
    fn reraise_chrome_then_self() {
        std::thread::spawn(|| {
            // Step 1: ask Chrome to come to the front. This raises Chrome's
            // windows above all OTHER apps — but because Deepthix's main
            // window has a sub-normal level, Chrome stays drawn above
            // Deepthix even after the next step.
            //
            // Step 2: re-activate Deepthix via System Events. Using
            // `frontmost of process X`, not `tell app X to activate`,
            // because the latter would force Deepthix to bring all its
            // windows above all of Chrome's. `frontmost` is the lighter
            // touch — it makes Deepthix the active app (so it receives
            // keystrokes) without aggressive window restacking. Combined
            // with the sub-normal window level, this leaves Chrome
            // visually on top while Deepthix has keyboard focus.
            let script = r#"
try
  tell application "Google Chrome" to activate
end try
try
  tell application "System Events" to set frontmost of (first process whose unix id is OUR_PID) to true
end try
"#;
            let script = script.replace("OUR_PID", &our_pid().to_string());
            match super::run_osascript(&script) {
                Ok(_) => {
                    tracing::trace!(
                        target: "deepthix::embedded_browser",
                        "re-raise sequence ok"
                    );
                }
                Err(e) => {
                    tracing::debug!(
                        target: "deepthix::embedded_browser",
                        error = %e,
                        "re-raise sequence failed (non-fatal)"
                    );
                }
            }
        });
    }

}
