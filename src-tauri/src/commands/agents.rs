// AGENTS: bridge between the ÉQUIPE / MISSIONS tabs and the agent engine that
// lives on the Mac mini in ~/.elyone/agents (Python, see moteur/api.py).
//
// One generic command: the UI passes an action + arguments (and optionally a
// JSON payload on stdin); the engine answers with JSON. All file, git and
// SQLite work happens in the engine, so the app stays a thin client and the
// same API is usable from the remote (iPhone) UI.
//
// Runs on a blocking worker — never on the main thread (freeze incident
// 2026-09-30): the engine may commit/push the agents configuration.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const ALLOWED: &[&str] = &[
    "etat",
    "agent",
    "bibliotheque",
    "comptes",
    "missions",
    "historique",
    "maj_agent",
    "competence",
    "pause",
    "reprise",
    "revenir",
    "creer_agent",
    "ajouter_compte",
    "compte_affecter",
    "valider",
    "outils",
    "personnes",
    "accueil",
    "demander",
    "moi",
    "utilisateurs",
    "maj_utilisateur",
    "suppr_utilisateur",
    "responsables",
    "fil",
    "repondre",
    "competence_lire",
    "competence_maj",
    "competence_creer",
    "proposition_decider",
    "propositions_en_attente",
];

/// Subset reachable from the REMOTE UI (collaborators): read the home page and
/// missions, approve/refuse, ask an agent. No configuration of agents remotely.
const COLLAB_ALLOWED: &[&str] = &["accueil", "missions", "valider", "demander", "etat", "moi", "fil", "repondre"];

fn engine_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let dir = home.join(".elyone").join("agents");
    if !dir.join("moteur").join("api.py").exists() {
        return Err("Moteur d'agents absent sur cette machine (~/.elyone/agents). Il tourne sur le Mac mini.".into());
    }
    Ok(dir)
}

fn run_blocking(action: String, args: Vec<String>, input: Option<String>, allowed: &[&str], caller: String) -> Result<String, String> {
    if !allowed.contains(&action.as_str()) {
        return Err(format!("action non autorisée : {action}"));
    }
    let dir = engine_dir()?;
    let python = dir.join("venv").join("bin").join("python");
    let mut cmd = Command::new(&python);
    cmd.arg("-I")
        .arg("-W")
        .arg("ignore")
        .arg(dir.join("moteur").join("api.py"))
        .arg(&action)
        .args(&args)
        // Who is asking: the engine applies the user's rights (utilisateurs.json).
        .env("ELYONE_CALLER", &caller)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("lancement du moteur impossible : {e}"))?;
    if let Some(data) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("moteur : réponse vide ({})", stderr.trim().chars().take(300).collect::<String>()));
    }
    Ok(stdout)
}

/// Calls the agent engine. Returns its raw JSON answer (parsed in the webview).
#[tauri::command]
pub async fn agents_api(
    action: String,
    args: Option<Vec<String>>,
    input: Option<String>,
    caller: Option<String>,
) -> Result<String, String> {
    // Local app = the owner of this Mac; remote = identity injected by the
    // remote server from the verified Cloudflare Access token.
    let caller = caller.filter(|c| !c.is_empty()).unwrap_or_else(crate::agents_users::owner_email);
    tauri::async_runtime::spawn_blocking(move || run_blocking(action, args.unwrap_or_default(), input, ALLOWED, caller))
        .await
        .map_err(|e| e.to_string())?
}

/// Collaborator entry point (the only one allowed remotely): restricted actions.
#[tauri::command]
pub async fn agents_collab(
    action: String,
    args: Option<Vec<String>>,
    input: Option<String>,
    caller: Option<String>,
) -> Result<String, String> {
    let caller = caller.filter(|c| !c.is_empty()).unwrap_or_else(crate::agents_users::owner_email);
    tauri::async_runtime::spawn_blocking(move || run_blocking(action, args.unwrap_or_default(), input, COLLAB_ALLOWED, caller))
        .await
        .map_err(|e| e.to_string())?
}
