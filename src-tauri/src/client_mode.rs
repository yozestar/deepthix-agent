//! Remote window: next to the local agent, a second window shows the agent
//! of another Mac, reached through that Mac's remote server (usually its
//! tailnet address, see `remote::server::Hub::start_tailnet`). The address
//! is saved in `client.json`; the window opens at launch when one is set,
//! and from the native "Connexion" menu (macOS) or Settings.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const CONFIG_FILE: &str = "client.json";
pub const WINDOW_LABEL: &str = "remote";

#[cfg(target_os = "macos")]
const MENU_OPEN: &str = "client-mode-open";
#[cfg(target_os = "macos")]
const MENU_RELOAD: &str = "client-mode-reload";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ClientConfig {
    /// Empty = no remote Mac configured.
    pub remote_url: String,
}

impl ClientConfig {
    pub fn path() -> std::io::Result<PathBuf> {
        Ok(crate::storage::deepthix_dir()?.join(CONFIG_FILE))
    }

    /// Missing or unreadable file → no remote Mac.
    pub fn load(path: &Path) -> ClientConfig {
        match crate::storage::read_json::<ClientConfig>(path) {
            Ok(Some(cfg)) => cfg,
            Ok(None) => ClientConfig::default(),
            Err(e) => {
                tracing::warn!(target: "deepthix::client", error = %e, ?path, "client.json unreadable, ignoring");
                ClientConfig::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        crate::storage::write_json(path, self)
    }
}

/// `https://host` / `http://host:port`, anything else is refused. A bare
/// host name gets `https://` (what `tailscale serve` answers on).
pub fn parse_remote_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("https://{raw}") };
    let url = Url::parse(&with_scheme).map_err(|e| format!("adresse invalide : {e}"))?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("adresse invalide : attendu https://nom-du-mac…".to_string());
    }
    Ok(url)
}

/// The saved remote Mac, if any.
pub fn remote_url() -> Option<Url> {
    let cfg = ClientConfig::load(&ClientConfig::path().ok()?);
    if cfg.remote_url.is_empty() {
        return None;
    }
    match parse_remote_url(&cfg.remote_url) {
        Ok(url) => Some(url),
        Err(e) => {
            tracing::warn!(target: "deepthix::client", error = %e, "client.json url unusable, ignoring");
            None
        }
    }
}

/// Saves the remote Mac (`None` = forget it, closing its window).
pub fn save(app: &AppHandle, url: Option<&Url>) -> Result<(), String> {
    let cfg = ClientConfig { remote_url: url.map(|u| u.to_string()).unwrap_or_default() };
    let path = ClientConfig::path().map_err(|e| e.to_string())?;
    cfg.save(&path).map_err(|e| e.to_string())?;
    tracing::info!(target: "deepthix::client", remote_url = %cfg.remote_url, "remote mac saved");
    if url.is_none() {
        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
            let _ = w.close();
        }
    }
    Ok(())
}

/// Shows the remote window, creating it (or pointing it at a new address).
pub fn open_window(app: &AppHandle, url: &Url) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        if w.url().ok().as_ref() != Some(url) {
            w.navigate(url.clone()).map_err(|e| e.to_string())?;
        }
        let _ = w.unminimize();
        return w.set_focus().map_err(|e| e.to_string());
    }
    let host = url.host_str().unwrap_or("Mac distant");
    let name = host.split('.').next().unwrap_or(host);
    // The page handles file drops itself; the native handler would eat them.
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url.clone()))
        .title(format!("Elyone — {name} (distant)"))
        .inner_size(1400.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .disable_drag_drop_handler()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Boot: native menu (macOS) and the remote window if a Mac is saved.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    install_menu(app)?;
    if let Some(url) = remote_url() {
        if let Err(e) = open_window(app, &url) {
            tracing::warn!(target: "deepthix::client", error = %e, "remote window failed to open");
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, Submenu};
    let menu = Menu::default(app)?;
    let connection = Submenu::with_items(
        app,
        "Connexion",
        true,
        &[
            &MenuItem::with_id(app, MENU_OPEN, "Ouvrir le Mac distant", true, Some("CmdOrCtrl+Shift+M"))?,
            &MenuItem::with_id(app, MENU_RELOAD, "Recharger le Mac distant", true, None::<&str>)?,
        ],
    )?;
    menu.append(&connection)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id != MENU_OPEN && id != MENU_RELOAD {
            return;
        }
        let Some(url) = remote_url() else {
            // Nothing saved yet: Settings is where the address goes.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            crate::commands::notifications::notify(
                app,
                "Aucun Mac distant",
                "Paramètres › MAC DISTANT : saisis son adresse Tailscale.",
                crate::commands::notifications::NotifKind::Warn,
                "client",
            );
            return;
        };
        if id == MENU_RELOAD {
            if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
                let _ = w.navigate(url.clone());
            }
        }
        if let Err(e) = open_window(app, &url) {
            tracing::error!(target: "deepthix::client", error = %e, "remote window failed to open");
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_host_gets_https() {
        let u = parse_remote_url(" mac-mini-de-ia.tail47dd5e.ts.net ").unwrap();
        assert_eq!(u.as_str(), "https://mac-mini-de-ia.tail47dd5e.ts.net/");
    }

    #[test]
    fn keeps_http_with_port_and_refuses_other_schemes() {
        assert_eq!(parse_remote_url("http://100.82.141.21:47822").unwrap().port(), Some(47822));
        assert!(parse_remote_url("file:///etc/passwd").is_err());
        assert!(parse_remote_url("").is_err());
    }

    #[test]
    fn missing_file_means_no_remote_mac() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        assert_eq!(ClientConfig::load(&path), ClientConfig::default());
        ClientConfig { remote_url: "https://x".into() }.save(&path).unwrap();
        assert_eq!(ClientConfig::load(&path).remote_url, "https://x");
    }
}
