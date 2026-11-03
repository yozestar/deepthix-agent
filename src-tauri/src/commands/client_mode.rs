//! Settings → "Mac distant": the other Mac whose agent opens in a second
//! window. Local-only (not in `remote::dispatch::REMOTE_COMMANDS`).

#[tauri::command]
pub fn client_mode_get() -> String {
    crate::client_mode::remote_url().map(|u| u.to_string()).unwrap_or_default()
}

/// Saves the address and opens its window; empty `url` forgets it.
#[tauri::command]
pub fn client_mode_set(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if url.trim().is_empty() {
        return crate::client_mode::save(&app, None);
    }
    let url = crate::client_mode::parse_remote_url(&url)?;
    crate::client_mode::save(&app, Some(&url))?;
    crate::client_mode::open_window(&app, &url)
}
