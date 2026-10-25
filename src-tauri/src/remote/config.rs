//! Persisted remote-access settings and paired devices (`remote.json`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 47821;
pub const CONFIG_FILE: &str = "remote.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub paired_ms: i64,
    pub last_seen_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RemoteConfig {
    pub enabled: bool,
    pub port: u16,
    pub require_cf_access: bool,
    pub cf_team_domain: String,
    pub cf_aud: String,
    /// The only identity Cloudflare Access may present (checked again here).
    pub cf_allowed_email: String,
    pub devices: Vec<Device>,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            require_cf_access: true,
            cf_team_domain: String::new(),
            cf_aud: String::new(),
            cf_allowed_email: String::new(),
            devices: Vec::new(),
        }
    }
}

impl RemoteConfig {
    pub fn path() -> std::io::Result<PathBuf> {
        Ok(crate::storage::deepthix_dir()?.join(CONFIG_FILE))
    }

    /// Missing or unreadable file → defaults (remote access off).
    pub fn load(path: &Path) -> RemoteConfig {
        match crate::storage::read_json::<RemoteConfig>(path) {
            Ok(Some(cfg)) => cfg,
            Ok(None) => RemoteConfig::default(),
            Err(e) => {
                tracing::warn!(target: "deepthix::remote", error = %e, ?path, "remote.json unreadable, using defaults");
                RemoteConfig::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        crate::storage::write_json(path, self)
    }

    pub fn find_device(&self, token: &str) -> Option<&Device> {
        if token.is_empty() {
            return None;
        }
        let hash = hash_token(token);
        self.devices
            .iter()
            .find(|d| constant_time_eq(d.token_hash.as_bytes(), hash.as_bytes()))
    }
}

/// 32 random bytes from the OS RNG, base64url without padding.
pub fn new_token() -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Hex SHA-256 — only this is ever written to disk.
pub fn hash_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(name: &str, token: &str) -> Device {
        Device {
            id: format!("id-{name}"),
            name: name.into(),
            token_hash: hash_token(token),
            paired_ms: 1,
            last_seen_ms: 1,
        }
    }

    #[test]
    fn default_is_disabled() {
        let cfg = RemoteConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.port, 47821);
        assert!(cfg.require_cf_access);
        assert!(cfg.devices.is_empty());
    }

    #[test]
    fn roundtrip_save_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        let mut cfg = RemoteConfig::default();
        cfg.enabled = true;
        cfg.cf_aud = "aud".into();
        cfg.devices.push(device("iphone", "tok"));
        cfg.save(&path).unwrap();
        assert_eq!(RemoteConfig::load(&path), cfg);
    }

    #[test]
    fn missing_file_gives_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(RemoteConfig::load(&dir.path().join("nope.json")), RemoteConfig::default());
    }

    #[test]
    fn corrupt_file_gives_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(RemoteConfig::load(&path), RemoteConfig::default());
    }

    #[test]
    fn token_hash_never_equals_token() {
        let t = new_token();
        assert!(t.len() >= 43, "32 bytes base64url");
        assert_ne!(hash_token(&t), t);
        assert_eq!(hash_token(&t), hash_token(&t));
        assert_ne!(new_token(), new_token());
    }

    #[test]
    fn find_device_matches_only_right_token() {
        let mut cfg = RemoteConfig::default();
        cfg.devices.push(device("iphone", "tok-a"));
        cfg.devices.push(device("laptop", "tok-b"));
        assert_eq!(cfg.find_device("tok-b").map(|d| d.name.as_str()), Some("laptop"));
        assert!(cfg.find_device("tok-c").is_none());
        assert!(cfg.find_device("").is_none());
    }
}
