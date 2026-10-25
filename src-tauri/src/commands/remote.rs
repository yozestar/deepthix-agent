//! PC-side controls for remote access (never callable remotely — see
//! `remote::dispatch::is_remote_allowed`).

use tauri::State;

use crate::remote::glue::{RemoteState, RemoteStatus};

#[tauri::command]
pub async fn remote_get_status(state: State<'_, RemoteState>) -> Result<RemoteStatus, String> {
    Ok(state.status())
}

#[tauri::command]
pub async fn remote_set_enabled(state: State<'_, RemoteState>, enabled: bool) -> Result<RemoteStatus, String> {
    tracing::info!(target: "deepthix::remote", enabled, "remote_set_enabled");
    state.set_enabled(enabled).await?;
    Ok(state.status())
}

#[tauri::command]
pub async fn remote_revoke_device(state: State<'_, RemoteState>, id: String) -> Result<RemoteStatus, String> {
    tracing::info!(target: "deepthix::remote", %id, "remote_revoke_device");
    state.hub.revoke_device(&id)?;
    Ok(state.status())
}

#[tauri::command]
pub async fn remote_pair_respond(state: State<'_, RemoteState>, id: String, accept: bool) -> Result<(), String> {
    tracing::info!(target: "deepthix::remote", %id, accept, "remote_pair_respond");
    state.hub.respond_pair(&id, accept)
}

#[tauri::command]
pub async fn remote_set_cf(
    state: State<'_, RemoteState>,
    team_domain: String,
    aud: String,
    allowed_email: String,
) -> Result<RemoteStatus, String> {
    state
        .hub
        .update_config(|c| {
            c.cf_team_domain = team_domain.trim().to_string();
            c.cf_aud = aud.trim().to_string();
            c.cf_allowed_email = allowed_email.trim().to_string();
        })
        .map_err(|e| e.to_string())?;
    state.hub.clear_jwks();
    Ok(state.status())
}
