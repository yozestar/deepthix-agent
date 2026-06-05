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
    /// Hard cap on concurrent chat sessions Deepthix will spawn. Each
    /// claude process holds 200-250 MB resident, so a low cap protects
    /// the host from accidental pile-up. None → MAX_ACTIVE_SESSIONS
    /// constant (6). Clamped to [2, 20] on read.
    #[serde(default)]
    pub max_active_sessions: Option<u32>,
    /// How many trailing messages each session keeps in webview state.
    /// Older messages are dropped from the React tree to keep typing
    /// fluid even on long --resume'd sessions. None → 100. Clamped to
    /// [50, 500] on read.
    #[serde(default)]
    pub max_messages_per_session: Option<u32>,
    /// UI font: "pixel" (default FS Pixel Sans — original look) or
    /// "inter" (lighter, anti-aliased, easier on the eyes for long
    /// reading sessions). Drives the data-ui-font attribute on
    /// document.documentElement; does NOT affect xterm, which has its
    /// own terminal_font_family.
    #[serde(default)]
    pub ui_font: Option<String>,
    /// Multiplier on the root <html> font-size for the whole UI (rem-
    /// based text scales; pixel widths don't). 0.85..1.6. Default 1.0.
    /// Lets the user enlarge chat / sidebar / settings text without
    /// triggering the horizontal-overflow that the old CSS `zoom`
    /// approach caused (see commit 1de8396). xterm is unaffected; it
    /// keeps its own terminal_font_size.
    #[serde(default)]
    pub ui_text_scale: Option<f32>,
}

/// Read the user's active-session cap (clamped to a sane range), or
/// the default if unset / file missing. Used by chat_spawn so a cap
/// change in Settings takes effect immediately without restart.
pub fn active_session_cap() -> usize {
    let raw = read_global_config()
        .ok()
        .and_then(|c| c.max_active_sessions)
        .unwrap_or(crate::commands::chat::MAX_ACTIVE_SESSIONS as u32);
    // Max raised 20 → 50 — operator-mode users with many micro-projects
    // were silently capped. 50 × ~200 MB = ~10 GB, still within reach of
    // a 32 GB workstation; the actual ceiling is the user's RAM, not us.
    raw.clamp(2, 50) as usize
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
            max_active_sessions: None,
            max_messages_per_session: None,
            ui_font: None,
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
