//! Loopback HTTP + WebSocket server for remote access. Transport only: the
//! Tauri side plugs in through [`Backend`], which keeps this testable
//! without a running app.

use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::jwk::JwkSet;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};

use super::cf_access;
use super::config::{Device, RemoteConfig};
use super::pairing::{PairOutcome, PairRequest, PairingQueue, PAIR_TTL_MS};
use super::protocol::{ClientMsg, ServerMsg};

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// WebSocket messages can carry whole files (base64 images, scrollback).
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const EVENT_BUFFER: usize = 4096;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const JWKS_TTL: Duration = Duration::from_secs(3600);
const REMOTE_FLAG_SCRIPT: &str = "<script>window.__ELYONE_REMOTE__=1</script>";

pub trait Backend: Send + Sync + 'static {
    fn dispatch(&self, cmd: String, args: Value) -> BoxFut<Result<Value, String>>;
    /// UI bundle file (path relative to the bundle root) and its mime type.
    fn asset(&self, path: &str) -> Option<(Vec<u8>, String)>;
    fn on_pair_request(&self, req: &PairRequest);
    fn on_device_connected(&self, device: &Device);
}

struct Conn {
    device_id: Option<String>,
    tx: mpsc::UnboundedSender<ServerMsg>,
}

/// (token, device id) on accept, `None` on deny.
type PairReply = Option<(String, String)>;

pub struct Hub {
    cfg: RwLock<RemoteConfig>,
    cfg_path: Option<PathBuf>,
    backend: Arc<dyn Backend>,
    pairing: Mutex<PairingQueue>,
    pair_waiters: Mutex<HashMap<String, oneshot::Sender<PairReply>>>,
    conns: Mutex<HashMap<u64, Conn>>,
    next_conn: AtomicU64,
    events: broadcast::Sender<ServerMsg>,
    jwks: Mutex<Option<(JwkSet, Instant)>>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Hub {
    pub fn new(cfg: RemoteConfig, cfg_path: Option<PathBuf>, backend: Arc<dyn Backend>) -> Arc<Hub> {
        Arc::new(Hub {
            cfg: RwLock::new(cfg),
            cfg_path,
            backend,
            pairing: Mutex::new(PairingQueue::default()),
            pair_waiters: Mutex::new(HashMap::new()),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            events: broadcast::channel(EVENT_BUFFER).0,
            jwks: Mutex::new(None),
            shutdown: Mutex::new(None),
        })
    }

    pub fn config(&self) -> RemoteConfig {
        self.cfg.read().unwrap().clone()
    }

    /// Mutates the config and persists it (when backed by a file).
    pub fn update_config(&self, f: impl FnOnce(&mut RemoteConfig)) -> std::io::Result<()> {
        let snapshot = {
            let mut cfg = self.cfg.write().unwrap();
            f(&mut cfg);
            cfg.clone()
        };
        match &self.cfg_path {
            Some(path) => snapshot.save(path),
            None => Ok(()),
        }
    }

    pub fn set_jwks(&self, jwks: JwkSet) {
        *self.jwks.lock().unwrap() = Some((jwks, Instant::now()));
    }

    /// Forget cached signing keys (team domain changed).
    pub fn clear_jwks(&self) {
        *self.jwks.lock().unwrap() = None;
    }

    pub fn is_running(&self) -> bool {
        self.shutdown.lock().unwrap().is_some()
    }

    #[cfg(test)]
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ServerMsg> {
        self.events.subscribe()
    }

    /// Sends an event to every authenticated socket.
    pub fn publish(&self, name: &str, payload: Value) {
        let _ = self.events.send(ServerMsg::Event { name: name.to_string(), payload });
    }

    pub fn connected_device_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .conns
            .lock()
            .unwrap()
            .values()
            .filter_map(|c| c.device_id.clone())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    pub fn respond_pair(&self, id: &str, accept: bool) -> Result<(), String> {
        let outcome = self
            .pairing
            .lock()
            .unwrap()
            .respond(id, accept, now_ms())
            .ok_or_else(|| "unknown or expired pairing request".to_string())?;
        let waiter = self.pair_waiters.lock().unwrap().remove(id);
        let reply = match outcome {
            PairOutcome::Accepted { token, device } => {
                let device_id = device.id.clone();
                self.update_config(|c| c.devices.push(device)).map_err(|e| e.to_string())?;
                Some((token, device_id))
            }
            PairOutcome::Denied => None,
        };
        if let Some(w) = waiter {
            let _ = w.send(reply);
        }
        Ok(())
    }

    pub fn revoke_device(&self, id: &str) -> Result<(), String> {
        self.update_config(|c| c.devices.retain(|d| d.id != id))
            .map_err(|e| e.to_string())?;
        for conn in self.conns.lock().unwrap().values() {
            if conn.device_id.as_deref() == Some(id) {
                let _ = conn.tx.send(ServerMsg::Bye { reason: "revoked".into() });
            }
        }
        Ok(())
    }

    /// Binds `127.0.0.1:port` (0 = ephemeral) and serves until [`Hub::stop`].
    pub async fn start(self: &Arc<Self>, port: u16) -> std::io::Result<SocketAddr> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
        let addr = listener.local_addr()?;
        let (tx, rx) = oneshot::channel::<()>();
        *self.shutdown.lock().unwrap() = Some(tx);
        let app = Router::new()
            .route("/ws", get(ws_handler))
            .fallback(get(asset_handler))
            .with_state(self.clone());
        tokio::spawn(async move {
            let served = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
            if let Err(e) = served {
                tracing::warn!(target: "deepthix::remote", error = %e, "server stopped with error");
            }
        });
        tracing::info!(target: "deepthix::remote", %addr, "remote server listening");
        Ok(addr)
    }

    /// Closes every socket (sending `bye`) and the listener.
    pub fn stop(&self, reason: &str) {
        for conn in self.conns.lock().unwrap().values() {
            let _ = conn.tx.send(ServerMsg::Bye { reason: reason.to_string() });
        }
        if let Some(tx) = self.shutdown.lock().unwrap().take() {
            let _ = tx.send(());
        }
        tracing::info!(target: "deepthix::remote", reason, "remote server stopped");
    }

    async fn check_cf_access(&self, headers: &HeaderMap) -> Result<(), String> {
        let cfg = self.config();
        if !cfg.require_cf_access {
            return Ok(());
        }
        let token = headers
            .get(cf_access::JWT_HEADER)
            .and_then(|v| v.to_str().ok())
            .ok_or("missing cloudflare access token")?;
        let cached = self
            .jwks
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(_, at)| at.elapsed() < JWKS_TTL)
            .map(|(k, _)| k.clone());
        let jwks = match cached {
            Some(k) => k,
            None => {
                let fetched = fetch_jwks(&cfg.cf_team_domain).await?;
                self.set_jwks(fetched.clone());
                fetched
            }
        };
        cf_access::verify_with_jwks(token, &jwks, &cfg.cf_team_domain, &cfg.cf_aud, &cfg.cf_allowed_email)
            .map(|_| ())
    }

    fn hello(&self, conn_id: u64, token: &str) -> Option<Device> {
        let device = self.config().find_device(token).cloned()?;
        let seen = now_ms();
        if let Err(e) = self.update_config(|c| {
            if let Some(d) = c.devices.iter_mut().find(|d| d.id == device.id) {
                d.last_seen_ms = seen;
            }
        }) {
            tracing::warn!(target: "deepthix::remote", error = %e, "could not persist last_seen");
        }
        self.mark_device(conn_id, &device.id);
        self.backend.on_device_connected(&device);
        Some(device)
    }

    fn mark_device(&self, conn_id: u64, device_id: &str) {
        if let Some(c) = self.conns.lock().unwrap().get_mut(&conn_id) {
            c.device_id = Some(device_id.to_string());
        }
    }

    fn start_pairing(&self, name: String) -> (PairRequest, oneshot::Receiver<PairReply>) {
        let req = self.pairing.lock().unwrap().request(name, now_ms());
        let (tx, rx) = oneshot::channel();
        self.pair_waiters.lock().unwrap().insert(req.id.clone(), tx);
        self.backend.on_pair_request(&req);
        self.publish(
            "remote_pair_request",
            json!({ "id": req.id, "code": req.code, "name": req.name }),
        );
        (req, rx)
    }
}

async fn fetch_jwks(team_domain: &str) -> Result<JwkSet, String> {
    if team_domain.is_empty() {
        return Err("cloudflare team domain not configured".into());
    }
    let url = format!("https://{team_domain}/cdn-cgi/access/certs");
    reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("jwks fetch failed: {e}"))?
        .json::<JwkSet>()
        .await
        .map_err(|e| format!("jwks parse failed: {e}"))
}

async fn ws_handler(State(hub): State<Arc<Hub>>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    if let Err(e) = hub.check_cf_access(&headers).await {
        tracing::warn!(target: "deepthix::remote", error = %e, "websocket refused");
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(hub, socket))
}

async fn next_event(rx: &mut Option<broadcast::Receiver<ServerMsg>>) -> ServerMsg {
    let Some(rx) = rx.as_mut() else {
        return std::future::pending().await;
    };
    loop {
        match rx.recv().await {
            Ok(msg) => return msg,
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!(target: "deepthix::remote", skipped = n, "slow client dropped events");
            }
            Err(broadcast::error::RecvError::Closed) => return std::future::pending().await,
        }
    }
}

async fn next_pair_reply(rx: &mut Option<oneshot::Receiver<PairReply>>) -> PairReply {
    let Some(r) = rx.as_mut() else {
        return std::future::pending().await;
    };
    let ttl = Duration::from_millis(PAIR_TTL_MS as u64);
    match tokio::time::timeout(ttl, r).await {
        Ok(Ok(reply)) => reply,
        _ => None,
    }
}

async fn handle_socket(hub: Arc<Hub>, socket: WebSocket) {
    let conn_id = hub.next_conn.fetch_add(1, Ordering::Relaxed);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ServerMsg>();
    hub.conns
        .lock()
        .unwrap()
        .insert(conn_id, Conn { device_id: None, tx: out_tx.clone() });
    let (mut sink, mut stream) = socket.split();

    // Writer: sends queued messages; a `bye` is the last one, then close.
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            let is_bye = matches!(msg, ServerMsg::Bye { .. });
            let text = serde_json::to_string(&msg).unwrap_or_default();
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
            if is_bye {
                let _ = sink.close().await;
                break;
            }
        }
    });

    let bye = |reason: &str| {
        let _ = out_tx.send(ServerMsg::Bye { reason: reason.to_string() });
    };
    let mut events: Option<broadcast::Receiver<ServerMsg>> = None;
    let mut pair_reply: Option<oneshot::Receiver<PairReply>> = None;
    let hello_deadline = tokio::time::sleep(HELLO_TIMEOUT);
    tokio::pin!(hello_deadline);

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => continue,
                };
                let msg = match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::debug!(target: "deepthix::remote", error = %e, "bad client message");
                        continue;
                    }
                };
                let ready = events.is_some();
                match msg {
                    ClientMsg::Hello { token } if !ready => match hub.hello(conn_id, &token) {
                        Some(_) => {
                            events = Some(hub.events.subscribe());
                            let _ = out_tx.send(ServerMsg::Ready);
                        }
                        None => bye("unknown device"),
                    },
                    ClientMsg::Pair { name } if !ready && pair_reply.is_none() => {
                        let (req, rx) = hub.start_pairing(name);
                        pair_reply = Some(rx);
                        let _ = out_tx.send(ServerMsg::PairPending { code: req.code });
                    }
                    ClientMsg::Invoke { id, cmd, args } if ready => {
                        let backend = hub.backend.clone();
                        let tx = out_tx.clone();
                        tokio::spawn(async move {
                            let msg = match backend.dispatch(cmd, args).await {
                                Ok(v) => ServerMsg::Result { id, ok: Some(v), err: None },
                                Err(e) => ServerMsg::Result { id, ok: None, err: Some(e) },
                            };
                            let _ = tx.send(msg);
                        });
                    }
                    ClientMsg::PairRespond { id, accept } if ready => {
                        if let Err(e) = hub.respond_pair(&id, accept) {
                            tracing::info!(target: "deepthix::remote", error = %e, "pair_respond ignored");
                        }
                    }
                    ClientMsg::Disable if ready => {
                        if let Err(e) = hub.update_config(|c| c.enabled = false) {
                            tracing::warn!(target: "deepthix::remote", error = %e, "could not persist disable");
                        }
                        hub.stop("disabled remotely");
                    }
                    _ if !ready => bye("not authenticated"),
                    _ => {}
                }
            }
            ev = next_event(&mut events) => {
                let _ = out_tx.send(ev);
            }
            reply = next_pair_reply(&mut pair_reply) => {
                pair_reply = None;
                match reply {
                    Some((token, device_id)) => {
                        hub.mark_device(conn_id, &device_id);
                        events = Some(hub.events.subscribe());
                        let _ = out_tx.send(ServerMsg::Paired { token });
                        let _ = out_tx.send(ServerMsg::Ready);
                    }
                    None => {
                        let _ = out_tx.send(ServerMsg::PairDenied);
                        bye("pairing denied");
                    }
                }
            }
            _ = &mut hello_deadline, if events.is_none() && pair_reply.is_none() => {
                bye("hello timeout");
            }
            _ = out_tx.closed() => break,
        }
    }

    hub.conns.lock().unwrap().remove(&conn_id);
    drop(out_tx);
    let _ = writer.await;
}

async fn asset_handler(State(hub): State<Arc<Hub>>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let (bytes, mime, is_index) = match hub.backend.asset(path) {
        Some((b, m)) => (b, m, path == "index.html"),
        // Unknown route → the single-page app handles it.
        None => match hub.backend.asset("index.html") {
            Some((b, m)) => (b, m, true),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
    };
    let mut builder = Response::builder().header(header::CONTENT_TYPE, mime);
    let body = if is_index {
        builder = builder.header(header::CACHE_CONTROL, "no-store");
        Body::from(inject_remote_flag(&String::from_utf8_lossy(&bytes)))
    } else {
        Body::from(bytes)
    };
    builder.body(body).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn inject_remote_flag(html: &str) -> String {
    let at = html.find("<script").or_else(|| html.find("</head>")).unwrap_or(0);
    format!("{}{}{}", &html[..at], REMOTE_FLAG_SCRIPT, &html[at..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::cf_access::test_support as cf;
    use crate::remote::config::{hash_token, Device, RemoteConfig};
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message as WsMsg;

    #[derive(Default)]
    struct FakeBackend {
        pair_requests: Mutex<Vec<PairRequest>>,
        connected: Mutex<Vec<String>>,
    }

    impl Backend for FakeBackend {
        fn dispatch(&self, cmd: String, args: Value) -> BoxFut<Result<Value, String>> {
            Box::pin(async move {
                match cmd.as_str() {
                    "echo" => Ok(args),
                    "hang" => std::future::pending().await,
                    other => Err(format!("unknown {other}")),
                }
            })
        }
        fn asset(&self, path: &str) -> Option<(Vec<u8>, String)> {
            match path {
                "index.html" => Some((b"<html><head><script src=\"/a.js\"></script></head></html>".to_vec(), "text/html".into())),
                "assets/app.js" => Some((b"console.log(1)".to_vec(), "text/javascript".into())),
                _ => None,
            }
        }
        fn on_pair_request(&self, req: &PairRequest) {
            self.pair_requests.lock().unwrap().push(req.clone());
        }
        fn on_device_connected(&self, device: &Device) {
            self.connected.lock().unwrap().push(device.name.clone());
        }
    }

    type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    fn cfg_with_device(token: &str) -> RemoteConfig {
        let mut cfg = RemoteConfig::default();
        cfg.require_cf_access = false;
        cfg.devices.push(Device {
            id: "dev-1".into(),
            name: "iPhone".into(),
            token_hash: hash_token(token),
            paired_ms: 0,
            last_seen_ms: 0,
        });
        cfg
    }

    async fn serve(cfg: RemoteConfig) -> (Arc<Hub>, Arc<FakeBackend>, std::net::SocketAddr) {
        let backend = Arc::new(FakeBackend::default());
        let hub = Hub::new(cfg, None, backend.clone());
        let addr = hub.start(0).await.unwrap();
        (hub, backend, addr)
    }

    async fn connect(addr: std::net::SocketAddr, jwt: Option<&str>) -> Result<Client, String> {
        let mut req = format!("ws://{addr}/ws").into_client_request().unwrap();
        if let Some(j) = jwt {
            req.headers_mut().insert(crate::remote::cf_access::JWT_HEADER, j.parse().unwrap());
        }
        // Browsers have no frame cap; tungstenite's client defaults to 16 MiB.
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        tokio_tungstenite::connect_async_with_config(req, Some(config), false)
            .await
            .map(|(c, _)| c)
            .map_err(|e| e.to_string())
    }

    async fn send(c: &mut Client, v: Value) {
        c.send(WsMsg::Text(v.to_string().into())).await.unwrap();
    }

    /// Next JSON message, or None when the socket closed.
    async fn recv(c: &mut Client) -> Option<Value> {
        loop {
            let m = tokio::time::timeout(Duration::from_secs(5), c.next()).await.expect("timeout")?;
            match m {
                Ok(WsMsg::Text(t)) => return Some(serde_json::from_str(&t).unwrap()),
                Ok(WsMsg::Close(_)) | Err(_) => return None,
                _ => continue,
            }
        }
    }

    async fn ready_client(addr: std::net::SocketAddr, token: &str) -> Client {
        let mut c = connect(addr, None).await.unwrap();
        send(&mut c, json!({"t":"hello","token":token})).await;
        assert_eq!(recv(&mut c).await, Some(json!({"t":"ready"})));
        c
    }

    #[tokio::test]
    async fn binds_loopback_only() {
        let (_hub, _b, addr) = serve(RemoteConfig::default()).await;
        assert!(addr.ip().is_loopback());
    }

    #[tokio::test]
    async fn unauthed_invoke_is_rejected() {
        let (_hub, _b, addr) = serve(cfg_with_device("tok")).await;
        let mut c = connect(addr, None).await.unwrap();
        send(&mut c, json!({"t":"invoke","id":1,"cmd":"echo","args":{}})).await;
        assert_eq!(recv(&mut c).await.unwrap()["t"], "bye");
        assert_eq!(recv(&mut c).await, None);
    }

    #[tokio::test]
    async fn unknown_token_is_rejected() {
        let (_hub, _b, addr) = serve(cfg_with_device("tok")).await;
        let mut c = connect(addr, None).await.unwrap();
        send(&mut c, json!({"t":"hello","token":"wrong"})).await;
        assert_eq!(recv(&mut c).await.unwrap()["t"], "bye");
    }

    #[tokio::test]
    async fn hello_with_valid_token_gets_ready_and_invokes() {
        let (hub, backend, addr) = serve(cfg_with_device("tok")).await;
        let mut c = ready_client(addr, "tok").await;
        send(&mut c, json!({"t":"invoke","id":7,"cmd":"echo","args":{"a":1}})).await;
        assert_eq!(recv(&mut c).await, Some(json!({"t":"result","id":7,"ok":{"a":1}})));
        send(&mut c, json!({"t":"invoke","id":8,"cmd":"nope"})).await;
        assert_eq!(recv(&mut c).await, Some(json!({"t":"result","id":8,"err":"unknown nope"})));
        assert_eq!(backend.connected.lock().unwrap().as_slice(), ["iPhone"]);
        assert!(hub.config().devices[0].last_seen_ms > 0);
        assert_eq!(hub.connected_device_ids(), vec!["dev-1".to_string()]);
    }

    fn cf_cfg() -> RemoteConfig {
        let mut cfg = cfg_with_device("tok");
        cfg.require_cf_access = true;
        cfg.cf_team_domain = cf::TEAM.into();
        cfg.cf_aud = cf::AUD.into();
        cfg.cf_allowed_email = cf::EMAIL.into();
        cfg
    }

    #[tokio::test]
    async fn missing_cf_jwt_is_rejected() {
        let (hub, _b, addr) = serve(cf_cfg()).await;
        hub.set_jwks(cf::jwks());
        assert!(connect(addr, None).await.is_err());
        let bad = cf::sign("other-aud", cf::EMAIL, &format!("https://{}", cf::TEAM), 300);
        assert!(connect(addr, Some(&bad)).await.is_err());
    }

    #[tokio::test]
    async fn valid_cf_jwt_and_token_gets_ready() {
        let (hub, _b, addr) = serve(cf_cfg()).await;
        hub.set_jwks(cf::jwks());
        let mut c = connect(addr, Some(&cf::valid())).await.unwrap();
        send(&mut c, json!({"t":"hello","token":"tok"})).await;
        assert_eq!(recv(&mut c).await, Some(json!({"t":"ready"})));
    }

    #[tokio::test]
    async fn events_fan_out_to_every_authed_socket() {
        let (hub, _b, addr) = serve(cfg_with_device("tok")).await;
        let mut a = ready_client(addr, "tok").await;
        let mut b = ready_client(addr, "tok").await;
        hub.publish("pty_data", json!({"id":"t1","data":"hi"}));
        let expected = json!({"t":"event","name":"pty_data","payload":{"id":"t1","data":"hi"}});
        assert_eq!(recv(&mut a).await, Some(expected.clone()));
        assert_eq!(recv(&mut b).await, Some(expected));
    }

    #[tokio::test]
    async fn disable_closes_live_sockets() {
        let (hub, _b, addr) = serve(cfg_with_device("tok")).await;
        let mut c = ready_client(addr, "tok").await;
        send(&mut c, json!({"t":"invoke","id":1,"cmd":"hang"})).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        hub.stop("disabled");
        assert_eq!(recv(&mut c).await, Some(json!({"t":"bye","reason":"disabled"})));
        assert_eq!(recv(&mut c).await, None);
        assert!(connect(addr, None).await.is_err(), "listener must be closed");
    }

    #[tokio::test]
    async fn revoke_kicks_the_device_socket() {
        let (hub, _b, addr) = serve(cfg_with_device("tok")).await;
        let mut c = ready_client(addr, "tok").await;
        hub.revoke_device("dev-1").unwrap();
        assert_eq!(recv(&mut c).await, Some(json!({"t":"bye","reason":"revoked"})));
        assert!(hub.config().devices.is_empty());
        let mut again = connect(addr, None).await.unwrap();
        send(&mut again, json!({"t":"hello","token":"tok"})).await;
        assert_eq!(recv(&mut again).await.unwrap()["t"], "bye");
    }

    #[tokio::test]
    async fn large_message_roundtrip() {
        let (_hub, _b, addr) = serve(cfg_with_device("tok")).await;
        let mut c = ready_client(addr, "tok").await;
        let big = "x".repeat(20 * 1024 * 1024);
        send(&mut c, json!({"t":"invoke","id":1,"cmd":"echo","args":{"s":big}})).await;
        let r = recv(&mut c).await.unwrap();
        assert_eq!(r["ok"]["s"].as_str().map(str::len), Some(20 * 1024 * 1024));
    }

    #[tokio::test]
    async fn pairing_accept_flow() {
        let (hub, backend, addr) = serve(cfg_with_device("tok")).await;
        let mut c = connect(addr, None).await.unwrap();
        send(&mut c, json!({"t":"pair","name":"MacBook"})).await;
        let pending = recv(&mut c).await.unwrap();
        assert_eq!(pending["t"], "pair_pending");
        let req = backend.pair_requests.lock().unwrap()[0].clone();
        assert_eq!(pending["code"], req.code.as_str());
        hub.respond_pair(&req.id, true).unwrap();
        let paired = recv(&mut c).await.unwrap();
        assert_eq!(paired["t"], "paired");
        assert_eq!(recv(&mut c).await, Some(json!({"t":"ready"})));
        let token = paired["token"].as_str().unwrap().to_string();
        assert!(hub.config().devices.iter().any(|d| d.name == "MacBook"));
        let _again = ready_client(addr, &token).await;
    }

    #[tokio::test]
    async fn pairing_denied_flow() {
        let (hub, backend, addr) = serve(cfg_with_device("tok")).await;
        let mut c = connect(addr, None).await.unwrap();
        send(&mut c, json!({"t":"pair","name":"Unknown"})).await;
        recv(&mut c).await.unwrap();
        let req = backend.pair_requests.lock().unwrap()[0].clone();
        hub.respond_pair(&req.id, false).unwrap();
        assert_eq!(recv(&mut c).await, Some(json!({"t":"pair_denied"})));
        assert_eq!(recv(&mut c).await.unwrap()["t"], "bye");
        assert_eq!(hub.config().devices.len(), 1);
    }

    #[tokio::test]
    async fn paired_device_can_approve_a_new_one() {
        let (_hub, _b, addr) = serve(cfg_with_device("tok")).await;
        let mut approver = ready_client(addr, "tok").await;
        let mut newcomer = connect(addr, None).await.unwrap();
        send(&mut newcomer, json!({"t":"pair","name":"iPad"})).await;
        recv(&mut newcomer).await.unwrap();
        let ev = recv(&mut approver).await.unwrap();
        assert_eq!(ev["name"], "remote_pair_request");
        let id = ev["payload"]["id"].as_str().unwrap().to_string();
        send(&mut approver, json!({"t":"pair_respond","id":id,"accept":true})).await;
        assert_eq!(recv(&mut newcomer).await.unwrap()["t"], "paired");
    }

    #[tokio::test]
    async fn client_disable_turns_off_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote.json");
        let mut cfg = cfg_with_device("tok");
        cfg.enabled = true;
        let backend = Arc::new(FakeBackend::default());
        let hub = Hub::new(cfg, Some(path.clone()), backend);
        let addr = hub.start(0).await.unwrap();
        let mut c = ready_client(addr, "tok").await;
        send(&mut c, json!({"t":"disable"})).await;
        assert_eq!(recv(&mut c).await.unwrap()["t"], "bye");
        assert!(!hub.config().enabled);
        assert!(!RemoteConfig::load(&path).enabled);
    }

    #[tokio::test]
    async fn serves_index_with_remote_flag_and_assets() {
        let (_hub, _b, addr) = serve(RemoteConfig::default()).await;
        let index = reqwest::get(format!("http://{addr}/")).await.unwrap().text().await.unwrap();
        let flag = index.find("__ELYONE_REMOTE__").expect("flag injected");
        assert!(flag < index.find("<script src").unwrap(), "flag before first script");
        let js = reqwest::get(format!("http://{addr}/assets/app.js")).await.unwrap();
        assert_eq!(js.headers()["content-type"], "text/javascript");
        assert_eq!(js.text().await.unwrap(), "console.log(1)");
        let spa = reqwest::get(format!("http://{addr}/some/route")).await.unwrap().text().await.unwrap();
        assert!(spa.contains("__ELYONE_REMOTE__"));
    }
}
