//! Open a URL in the user's real Google Chrome (separate from the Tauri webview).
//!
//! Tauri's WebView on macOS is WKWebView (Safari engine). For Deepthix sessions
//! we want the user's real Chrome — different engine, dev tools, extensions
//! they actually use, etc. This command spawns a detached Chrome window via
//! `open -na "Google Chrome" --args --app=<url> --window-size=<w>,<h>`.
//!
//! Closing the window does NOT affect anything in the Deepthix session.

use std::process::Command;

/// Open `url` in Google Chrome at the requested viewport size.
///
/// Returns Err if Chrome can't be launched (e.g. not installed, or `open`
/// returns non-zero). The frontend should surface that to the user.
#[tauri::command]
pub fn open_chrome(url: String, width: u32, height: u32) -> Result<(), String> {
    tracing::info!(
        target: "deepthix::commands",
        %url, %width, %height,
        "open_chrome"
    );

    if url.trim().is_empty() {
        return Err("open_chrome: url is empty".to_string());
    }

    // `open -na "Google Chrome" --args ...` opens a NEW Chrome instance with
    // the given args appended (Chrome's CLI flags). `--app=<url>` makes Chrome
    // open a chrome-less app window for the URL. `--window-size=W,H` sets the
    // initial dimensions. `--new-window` ensures we don't fold into an existing
    // tab when an instance is already running.
    let app_arg = format!("--app={url}");
    let size_arg = format!("--window-size={width},{height}");

    tracing::debug!(
        target: "deepthix::commands",
        ?app_arg, ?size_arg,
        "open_chrome: spawning"
    );

    let status = Command::new("open")
        .args(["-na", "Google Chrome", "--args"])
        .arg(&app_arg)
        .arg(&size_arg)
        .arg("--new-window")
        .status()
        .map_err(|e| {
            tracing::error!(target: "deepthix::commands", error = %e, "open_chrome: spawn failed");
            format!("Failed to launch Chrome: {e}")
        })?;

    if !status.success() {
        tracing::warn!(
            target: "deepthix::commands",
            code = ?status.code(),
            "open_chrome: `open` exited with non-zero status (Chrome may not be installed)"
        );
        return Err(format!(
            "`open` exited with status {:?} — is Google Chrome installed at /Applications/Google Chrome.app?",
            status.code()
        ));
    }

    tracing::debug!(target: "deepthix::commands", "open_chrome: success");
    Ok(())
}

/// Open `url` in the user's default browser via macOS `open`. Used by the
/// xterm web-links addon — when the user clicks a URL inside a terminal
/// pane, we hand it off to the OS so it lands in their normal browser
/// instead of trying to render it inside the Tauri webview (which would
/// be wrong for arbitrary external links and is blocked by sandbox
/// anyway).
///
/// The url is validated to start with http:// or https:// so a malicious
/// terminal payload can't trick the user into running e.g. `file://...`
/// or `javascript:` URIs.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    tracing::info!(target: "deepthix::commands", %url, "open_external_url");
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(format!("refusing to open non-http(s) url: {trimmed}"));
    }
    let status = Command::new("open").arg(trimmed).status().map_err(|e| {
        tracing::error!(target: "deepthix::commands", error = %e, "open_external_url: spawn failed");
        format!("Failed to open url: {e}")
    })?;
    if !status.success() {
        return Err(format!("`open` exited with status {:?}", status.code()));
    }
    Ok(())
}
