//! Team users and their rights for the agents (design « utilisateurs et droits »).
//! The list lives with the agent engine on the Mac mini:
//! `~/.elyone/agents/utilisateurs.json` — managed from the ÉQUIPE space.
//! Rust only needs two things: who may open a remote connection (active users),
//! and who the local user is (the owner of this Mac).

use serde::Deserialize;

#[derive(Deserialize)]
struct User {
    email: String,
    #[serde(default = "yes")]
    actif: bool,
}
fn yes() -> bool {
    true
}

fn users() -> Vec<User> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let path = home.join(".elyone").join("agents").join("utilisateurs.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<User>>(&s).ok())
        .unwrap_or_default()
}

/// True when `email` is an active user of the team.
pub fn is_active_user(email: &str) -> bool {
    users().iter().any(|u| u.actif && u.email.eq_ignore_ascii_case(email.trim()))
}

/// The owner of this machine (local app): the remote-access owner email.
pub fn owner_email() -> String {
    crate::storage::deepthix_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("remote.json")).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("cf_allowed_email").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_default()
}
