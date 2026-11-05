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
];

fn engine_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let dir = home.join(".elyone").join("agents");
    if !dir.join("moteur").join("api.py").exists() {
        return Err("Moteur d'agents absent sur cette machine (~/.elyone/agents). Il tourne sur le Mac mini.".into());
    }
    Ok(dir)
}

fn run_blocking(action: String, args: Vec<String>, input: Option<String>) -> Result<String, String> {
    if !ALLOWED.contains(&action.as_str()) {
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
pub async fn agents_api(action: String, args: Option<Vec<String>>, input: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_blocking(action, args.unwrap_or_default(), input))
        .await
        .map_err(|e| e.to_string())?
}
