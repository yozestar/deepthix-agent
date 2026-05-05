// Global app config (Phase 11). One JSON file at ~/.deepthix/config.json
// shared by every project. Currently only carries terminal font/zoom
// preferences (formerly per-session in sessions.json — kept readable but
// ignored now via #[serde(default)] on the old fields).
//
// Adding a new global setting:
//   1. Add an Option<T> field to GlobalConfig with #[serde(default)].
//   2. Mirror it in webview-ui/src/hooks/useGlobalConfig.ts.
//   3. The atomic write (storage::write_json) preserves the previous file
//      on failure and creates ~/.deepthix/ on first call.

use serde::{Deserialize, Serialize};

use crate::storage;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GlobalConfig {
    /// Terminal font size in CSS pixels. None → frontend default.
    #[serde(default)]
    pub terminal_font_size: Option<i32>,
    /// CSS font-family list applied to xterm. None → frontend default.
    #[serde(default)]
    pub terminal_font_family: Option<String>,
    /// Line-height multiplier applied to xterm (1.0–1.6). None → default.
    #[serde(default)]
    pub terminal_line_height: Option<f32>,
    /// Theme id (color palette). None → frontend default.
    #[serde(default)]
    pub theme_id: Option<String>,
    /// Box / surface style: "pixel" (default hard-shadow), "glass"
    /// (frosted backdrop blur), "flat" (no shadow, thin border),
    /// "soft" (rounded + soft drop shadow), "neon" (glowing accent
    /// border). Drives the data-box-style attribute applied to
    /// document.documentElement so CSS rules can override surface
    /// chrome without touching component code.
    #[serde(default)]
    pub box_style: Option<String>,
}

#[tauri::command]
pub fn read_global_config() -> Result<GlobalConfig, String> {
    let dir = storage::deepthix_dir().map_err(|e| {
        tracing::warn!(target: "deepthix::commands", error = %e, "read_global_config: deepthix_dir failed");
        e.to_string()
    })?;
    let path = dir.join("config.json");
    tracing::debug!(target: "deepthix::commands", ?path, "read_global_config");
    let value = storage::read_json::<GlobalConfig>(&path).map_err(|e| {
        tracing::warn!(target: "deepthix::commands", ?path, error = %e, "read_global_config: read_json failed");
        e.to_string()
    })?;
    Ok(value.unwrap_or_default())
}

#[tauri::command]
pub fn write_global_config(config: GlobalConfig) -> Result<(), String> {
    let dir = storage::deepthix_dir().map_err(|e| {
        tracing::warn!(target: "deepthix::commands", error = %e, "write_global_config: deepthix_dir failed");
        e.to_string()
    })?;
    let path = dir.join("config.json");
    tracing::info!(target: "deepthix::commands", ?path, "write_global_config");
    storage::write_json(&path, &config).map_err(|e| {
        tracing::warn!(target: "deepthix::commands", ?path, error = %e, "write_global_config: write_json failed");
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_all_none() {
        let c = GlobalConfig::default();
        assert!(c.terminal_font_size.is_none());
        assert!(c.terminal_font_family.is_none());
        assert!(c.terminal_line_height.is_none());
    }

    #[test]
    fn config_serializes_with_snake_case_camel_keys() {
        // serde keeps Rust field names (snake_case) — the frontend uses
        // explicit camelCase via its own type and converts at the boundary.
        let c = GlobalConfig {
            terminal_font_size: Some(14),
            terminal_font_family: Some("Menlo, monospace".into()),
            terminal_line_height: Some(1.2),
            theme_id: Some("dracula".into()),
            box_style: None,
        };
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("terminal_font_size"));
        assert!(json.contains("terminal_font_family"));
        assert!(json.contains("terminal_line_height"));
    }

    #[test]
    fn config_deserializes_with_missing_fields() {
        // Older config.json may be empty `{}` — must not error.
        let c: GlobalConfig = serde_json::from_str("{}").unwrap();
        assert!(c.terminal_font_size.is_none());
    }
}
