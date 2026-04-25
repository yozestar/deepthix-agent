use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ProcessInfo {
    pub pid: i32,
    pub command: String,
    pub cwd: Option<String>,
}

/// Best-effort: list node-ish processes whose argv mentions the project path.
/// Uses `ps -ax -o pid=,command=` (BSD ps on macOS) and string-matches.
#[tauri::command]
pub fn list_processes(project_path: PathBuf) -> Result<Vec<ProcessInfo>, String> {
    tracing::debug!(target: "deepthix::commands", ?project_path, "list_processes");
    let needle = project_path.to_string_lossy().to_string();

    let output = Command::new("ps")
        .args(["-ax", "-o", "pid=,command="])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("ps failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let mut out = Vec::new();
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let line = line.trim_start();
        // pid is the first whitespace-separated token, rest is the command.
        let (pid_str, rest) = match line.find(' ') {
            Some(i) => (&line[..i], line[i..].trim()),
            None => continue,
        };
        let pid: i32 = match pid_str.parse() { Ok(n) => n, Err(_) => continue };

        // Tight filter: the process must mention the project path in its
        // argv. Otherwise the list fills up with unrelated `node`/`npm`
        // processes from other projects on the machine.
        if !rest.contains(&needle) { continue; }
        // Filter out our own deepthix processes / claude / shell.
        if rest.contains("target/debug/app") || rest.contains("target/release/app") { continue; }
        if rest.contains("claude --session-id") || rest.contains("claude --resume") { continue; }
        if rest.contains("tauri dev") { continue; }

        out.push(ProcessInfo {
            pid,
            command: rest.chars().take(200).collect(),
            cwd: None,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn kill_process(pid: i32) -> Result<(), String> {
    tracing::info!(target: "deepthix::commands", %pid, "kill_process");
    let status = Command::new("kill")
        .arg(pid.to_string())
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("kill {pid} failed"));
    }
    Ok(())
}
