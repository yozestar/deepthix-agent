//! Remote access: serves the UI to the owner's other devices through a
//! loopback HTTP/WebSocket server reached via Cloudflare Tunnel.

pub mod config;
pub mod dispatch;
pub mod pairing;
