//! Wires the remote server into the running Tauri app: command dispatch,
//! bundled UI assets, mirrored events, notifications, persisted switch.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Runtime};

use super::config::{Device, RemoteConfig};
use super::pairing::PairRequest;
use super::server::{Backend, BoxFut, Hub};

/// Events mirrored to remote clients (everything the UI listens to).
pub const BRIDGED_EVENTS: &[&str] = &[
    "pty_data",
    "chat_event",
    "chat_exit",
    "agent_jsonl_line",
    "deepthix-notification",
    "project_switched",
];

pub type Notify = Box<dyn Fn(&str, &str) + Send + Sync>;

pub struct RemoteState {
    pub hub: Arc<Hub>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub paired_ms: i64,
    pub last_seen_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub require_cf_access: bool,
    pub cf_team_domain: String,
    pub cf_aud: String,
    pub cf_allowed_email: String,
    pub devices: Vec<DeviceView>,
    pub connected: Vec<String>,
}

struct TauriBackend<R: Runtime> {
    app: AppHandle<R>,
    notify: Notify,
}

impl<R: Runtime> Backend for TauriBackend<R> {
    fn dispatch(&self, cmd: String, args: Value) -> BoxFut<Result<Value, String>> {
        let app = self.app.clone();
        Box::pin(async move { super::dispatch::dispatch(&app, &cmd, args).await })
    }

    fn asset(&self, path: &str) -> Option<(Vec<u8>, String)> {
        if let Some(a) = self.app.asset_resolver().get(path.to_string()) {
            return Some((a.bytes, a.mime_type));
        }
        dev_asset(path)
    }

    fn on_pair_request(&self, req: &PairRequest) {
        let payload = json!({ "id": req.id, "code": req.code, "name": req.name });
        if let Err(e) = self.app.emit("remote_pair_request", payload) {
            tracing::warn!(target: "deepthix::remote", error = %e, "emit remote_pair_request failed");
        }
        (self.notify)(
            "Demande d'accès à distance",
            &format!("{} — code {}", req.name, req.code),
        );
    }

    fn on_device_connected(&self, device: &Device) {
        (self.notify)("Nouvelle connexion à distance", &device.name);
    }
}

/// Debug builds load the UI from Vite's dev server, so nothing is embedded:
/// fall back to the last `npm run build` output on disk.
fn dev_asset(path: &str) -> Option<(Vec<u8>, String)> {
    if !cfg!(debug_assertions) || path.contains("..") {
        return None;
    }
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../dist/webview")
        .join(path);
    let bytes = std::fs::read(&file).ok()?;
    let mime = match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "webmanifest" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    };
    Some((bytes, mime.to_string()))
}

const RESTART_ATTEMPTS: u32 = 10;
const RESTART_DELAY: Duration = Duration::from_millis(200);

impl RemoteState {
    pub fn new<R: Runtime>(app: &AppHandle<R>, cfg_path: Option<PathBuf>, notify: Notify) -> Self {
        let cfg = cfg_path
            .as_deref()
            .map(RemoteConfig::load)
            .unwrap_or_default();
        let backend = Arc::new(TauriBackend { app: app.clone(), notify });
        RemoteState { hub: Hub::new(cfg, cfg_path, backend) }
    }

    /// Persists the switch and starts/stops the listener accordingly.
    pub async fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        if !enabled {
            self.hub.update_config(|c| c.enabled = false).map_err(|e| e.to_string())?;
            self.hub.stop("disabled");
            return Ok(());
        }
        if !self.hub.is_running() {
            self.start_listener().await?;
        }
        self.hub.update_config(|c| c.enabled = true).map_err(|e| e.to_string())
    }

    /// Called once at boot: restores the last persisted switch state.
    pub async fn start_if_enabled(&self) {
        if self.hub.config().enabled && !self.hub.is_running() {
            if let Err(e) = self.start_listener().await {
                tracing::error!(target: "deepthix::remote", error = %e, "remote server failed to start");
            }
        }
    }

    async fn start_listener(&self) -> Result<(), String> {
        // A just-stopped listener may still hold the port for a moment.
        let port = self.hub.config().port;
        let mut last_err = String::new();
        for _ in 0..RESTART_ATTEMPTS {
            match self.hub.start(port).await {
                Ok(_) => return Ok(()),
                Err(e) => last_err = e.to_string(),
            }
            tokio::time::sleep(RESTART_DELAY).await;
        }
        Err(format!("cannot listen on 127.0.0.1:{port}: {last_err}"))
    }

    pub fn status(&self) -> RemoteStatus {
        let cfg = self.hub.config();
        RemoteStatus {
            enabled: cfg.enabled,
            running: self.hub.is_running(),
            port: cfg.port,
            require_cf_access: cfg.require_cf_access,
            cf_team_domain: cfg.cf_team_domain,
            cf_aud: cfg.cf_aud,
            cf_allowed_email: cfg.cf_allowed_email,
            devices: cfg
                .devices
                .into_iter()
                .map(|d| DeviceView { id: d.id, name: d.name, paired_ms: d.paired_ms, last_seen_ms: d.last_seen_ms })
                .collect(),
            connected: self.hub.connected_device_ids(),
        }
    }
}

/// Mirrors every UI-facing Tauri event to the connected remote clients.
pub fn install_bridge<R: Runtime>(app: &AppHandle<R>, hub: Arc<Hub>) {
    for name in BRIDGED_EVENTS {
        let hub = hub.clone();
        app.listen_any(*name, move |event| {
            let payload = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            hub.publish(name, payload);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::protocol::ServerMsg;
    use serde_json::json;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app")
    }

    fn state_with_file(app: &tauri::App<tauri::test::MockRuntime>, path: &std::path::Path) -> RemoteState {
        let mut cfg = RemoteConfig::default();
        cfg.port = 0;
        cfg.save(path).unwrap();
        RemoteState::new(app.handle(), Some(path.to_path_buf()), Box::new(|_, _| {}))
    }

    #[tokio::test]
    async fn set_enabled_persists_and_starts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote.json");
        let app = app();
        let state = state_with_file(&app, &path);
        assert!(!state.status().running);

        state.set_enabled(true).await.unwrap();
        assert!(state.status().enabled && state.status().running);
        assert!(RemoteConfig::load(&path).enabled);

        state.set_enabled(false).await.unwrap();
        assert!(!state.status().enabled && !state.status().running);
        assert!(!RemoteConfig::load(&path).enabled);
    }

    #[tokio::test]
    async fn status_hides_token_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let app = app();
        let state = state_with_file(&app, &dir.path().join("remote.json"));
        let json = serde_json::to_string(&state.status()).unwrap();
        assert!(!json.contains("token_hash"));
    }

    #[tokio::test]
    async fn bridge_forwards_emitted_events() {
        let dir = tempfile::tempdir().unwrap();
        let app = app();
        let state = state_with_file(&app, &dir.path().join("remote.json"));
        install_bridge(app.handle(), state.hub.clone());
        let mut rx = state.hub.subscribe();
        app.handle().emit("pty_data", json!({"id":"t1","data":"x"})).unwrap();
        let got = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
        assert_eq!(
            got,
            ServerMsg::Event { name: "pty_data".into(), payload: json!({"id":"t1","data":"x"}) }
        );
    }
}
