//! Re-runnable import of the legacy Deepthix data folder (`~/.deepthix`)
//! into Elyone's own folder (`~/.elyone`).
//!
//! The user keeps working in Deepthix Agent v2 while Elyone is being
//! finalised, so the import must be repeatable up to the last minute:
//! every run replaces Elyone's copy of the shared data with a fresh copy
//! of the legacy folder, after backing up the current Elyone data.
//!
//! The legacy folder is only ever READ.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Top-level entries never copied from the legacy folder:
/// - logs / dropped: large and not needed (transcripts reference dropped
///   files by their legacy absolute path, which stays valid);
/// - files the app regenerates and that point at the legacy install
///   (MCP config -> Deepthix v2's deepthix-mcp.exe, statusline overlay).
const SKIP_TOP_LEVEL: &[&str] = &[
    "logs",
    "dropped",
    "claude-mcp-config.json",
    "claude-overlay-settings.json",
    "statusline-dumper.sh",
    "import-from-deepthix.json",
];

/// Elyone-owned files: copied only when absent (first import), never
/// overwritten afterwards — e.g. the Elyone theme/font settings.
const KEEP_IF_PRESENT: &[&str] = &["config.json"];

/// Backups kept in `~/.elyone-backups`.
const MAX_BACKUPS: usize = 3;

/// Marker written into the data folder after each import.
const MARKER_FILE: &str = "import-from-deepthix.json";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ImportReport {
    pub source: String,
    pub target: String,
    pub files_copied: usize,
    pub bytes_copied: u64,
    /// Where the previous Elyone data was saved (None on first import).
    pub backup: Option<String>,
    pub at_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ImportStatus {
    pub legacy_path: String,
    pub legacy_exists: bool,
    /// Epoch ms of the last import, None if never imported.
    pub last_import_ms: Option<u64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_backup_name(name: &str) -> bool {
    name.contains(".bak")
}

/// Recursive copy; returns (files, bytes). `top` = entries directly under
/// the legacy root, where the skip / keep rules apply.
fn copy_tree(src: &Path, dst: &Path, top: bool) -> std::io::Result<(usize, u64)> {
    std::fs::create_dir_all(dst)?;
    let mut files = 0;
    let mut bytes = 0;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_backup_name(&name) || (top && SKIP_TOP_LEVEL.contains(&name.as_str())) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if top && KEEP_IF_PRESENT.contains(&name.as_str()) && to.exists() {
            continue;
        }
        let ft = entry.file_type()?;
        if ft.is_dir() {
            let (f, b) = copy_tree(&from, &to, false)?;
            files += f;
            bytes += b;
        } else if ft.is_file() {
            bytes += std::fs::copy(&from, &to)?;
            files += 1;
        }
    }
    Ok((files, bytes))
}

/// Copy the current Elyone data (minus logs / dropped) to
/// `<backups_root>/<timestamp>` and prune to MAX_BACKUPS.
fn backup_current(dst: &Path, backups_root: &Path) -> std::io::Result<Option<PathBuf>> {
    if !dst.join("projects.json").exists() {
        return Ok(None);
    }
    let stamp = chrono_like_stamp();
    let target = backups_root.join(&stamp);
    copy_tree(dst, &target, true)?;
    let mut all: Vec<PathBuf> = std::fs::read_dir(backups_root)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    // Oldest first, by the numeric stamp (lexical order breaks when the
    // number of digits differs).
    let stamp_of = |p: &PathBuf| -> u64 {
        p.file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("import-"))
            .and_then(|n| n.parse().ok())
            .unwrap_or(0)
    };
    all.sort_by_key(stamp_of);
    while all.len() > MAX_BACKUPS {
        let oldest = all.remove(0);
        let _ = std::fs::remove_dir_all(oldest);
    }
    Ok(Some(target))
}

/// Sortable local-independent stamp (UTC seconds) without a date crate.
fn chrono_like_stamp() -> String {
    let secs = now_ms() / 1000;
    format!("import-{secs}")
}

/// Import `src` (legacy) into `dst` (Elyone). Replaces the shared data
/// (projects, sessions, variables, workflows, schedules, coach…), keeps
/// Elyone-owned settings, backs up the previous Elyone data first.
pub fn import_legacy(src: &Path, dst: &Path, backups_root: &Path) -> std::io::Result<ImportReport> {
    if !src.join("projects.json").exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("no Deepthix data found in {}", src.display()),
        ));
    }
    let backup = backup_current(dst, backups_root)?;
    // Per-project folders are replaced wholesale so projects removed in the
    // legacy app don't linger here.
    let projects_dir = dst.join("projects");
    if projects_dir.exists() {
        std::fs::remove_dir_all(&projects_dir)?;
    }
    let (files_copied, bytes_copied) = copy_tree(src, dst, true)?;
    let report = ImportReport {
        source: src.to_string_lossy().into_owned(),
        target: dst.to_string_lossy().into_owned(),
        files_copied,
        bytes_copied,
        backup: backup.map(|p| p.to_string_lossy().into_owned()),
        at_ms: now_ms(),
    };
    let marker = serde_json::to_vec_pretty(&report).unwrap_or_default();
    std::fs::write(dst.join(MARKER_FILE), marker)?;
    tracing::info!(target: "deepthix::migration", ?report, "imported legacy data");
    Ok(report)
}

fn default_paths() -> std::io::Result<(PathBuf, PathBuf, PathBuf)> {
    let home = dirs::home_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    Ok((
        home.join(crate::storage::LEGACY_DATA_DIR_NAME),
        crate::storage::data_dir_in(&home),
        home.join(".elyone-backups"),
    ))
}

/// First-launch import: runs only when Elyone has no projects yet and the
/// legacy folder has some. Errors are logged, never fatal.
pub fn import_on_first_launch() {
    let Ok((src, dst, backups)) = default_paths() else { return };
    if dst.join("projects.json").exists() || !src.join("projects.json").exists() {
        return;
    }
    if let Err(e) = import_legacy(&src, &dst, &backups) {
        tracing::error!(target: "deepthix::migration", error = %e, "first-launch import failed");
    }
}

#[tauri::command]
pub fn legacy_import_status() -> Result<ImportStatus, String> {
    let (src, dst, _) = default_paths().map_err(|e| e.to_string())?;
    let last_import_ms = std::fs::read_to_string(dst.join(MARKER_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("at_ms").and_then(|n| n.as_u64()));
    Ok(ImportStatus {
        legacy_path: src.to_string_lossy().into_owned(),
        legacy_exists: src.join("projects.json").exists(),
        last_import_ms,
    })
}

/// Re-run the import now (Settings button). The webview reloads afterwards
/// so every pane re-reads the fresh data.
#[tauri::command]
pub async fn import_from_deepthix(app: tauri::AppHandle) -> Result<ImportReport, String> {
    use tauri::Manager;
    let report = tauri::async_runtime::spawn_blocking(|| {
        let (src, dst, backups) = default_paths()?;
        import_legacy(&src, &dst, &backups)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    // The project list lives in memory: refresh it from the new file.
    app.state::<crate::state::AppState>()
        .reload()
        .map_err(|e| e.to_string())?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    #[test]
    fn import_copies_data_and_skips_logs_generated_and_backups() {
        let root = tempdir().unwrap();
        let src = root.path().join("legacy");
        let dst = root.path().join("elyone");
        let bk = root.path().join("backups");
        write(&src.join("projects.json"), "{\"projects\":[]}");
        write(&src.join("variables.json"), "[1]");
        write(&src.join("variables.json.bak"), "old");
        write(&src.join("projects/p1/sessions.json"), "[]");
        write(&src.join("logs/big.log"), "x");
        write(&src.join("dropped/a.png"), "x");
        write(&src.join("claude-mcp-config.json"), "{}");
        write(&src.join("config.json"), "{\"theme_id\":\"dracula\"}");

        let r = import_legacy(&src, &dst, &bk).unwrap();
        assert!(r.backup.is_none(), "first import has nothing to back up");
        assert!(dst.join("projects/p1/sessions.json").exists());
        assert!(dst.join("variables.json").exists());
        assert!(dst.join("config.json").exists(), "config copied on first import");
        assert!(!dst.join("variables.json.bak").exists());
        assert!(!dst.join("logs").exists());
        assert!(!dst.join("dropped").exists());
        assert!(!dst.join("claude-mcp-config.json").exists());
        assert!(dst.join(MARKER_FILE).exists());
        // Legacy folder untouched.
        assert!(src.join("logs/big.log").exists());
        assert!(src.join("variables.json.bak").exists());
    }

    #[test]
    fn reimport_refreshes_data_keeps_elyone_config_and_backs_up() {
        let root = tempdir().unwrap();
        let src = root.path().join("legacy");
        let dst = root.path().join("elyone");
        let bk = root.path().join("backups");
        write(&src.join("projects.json"), "v1");
        write(&src.join("projects/p1/sessions.json"), "[]");
        write(&src.join("config.json"), "legacy-config");
        import_legacy(&src, &dst, &bk).unwrap();

        // Elyone user changes its theme; legacy app keeps working.
        write(&dst.join("config.json"), "elyone-config");
        write(&src.join("projects.json"), "v2");
        std::fs::remove_dir_all(src.join("projects/p1")).unwrap();
        write(&src.join("projects/p2/sessions.json"), "[]");

        let r = import_legacy(&src, &dst, &bk).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("projects.json")).unwrap(), "v2");
        assert_eq!(std::fs::read_to_string(dst.join("config.json")).unwrap(), "elyone-config");
        assert!(!dst.join("projects/p1").exists(), "removed legacy project is gone");
        assert!(dst.join("projects/p2/sessions.json").exists());
        let backup = PathBuf::from(r.backup.expect("second import backs up"));
        assert_eq!(std::fs::read_to_string(backup.join("projects.json")).unwrap(), "v1");
    }

    #[test]
    fn import_fails_cleanly_without_legacy_data() {
        let root = tempdir().unwrap();
        let err = import_legacy(&root.path().join("nope"), &root.path().join("e"), &root.path().join("b"));
        assert!(err.is_err());
        assert!(!root.path().join("e").exists());
    }

    #[test]
    fn backups_are_pruned_to_max() {
        let root = tempdir().unwrap();
        let dst = root.path().join("elyone");
        let bk = root.path().join("backups");
        write(&dst.join("projects.json"), "x");
        for i in 0..5 {
            std::fs::create_dir_all(bk.join(format!("import-{i}"))).unwrap();
        }
        backup_current(&dst, &bk).unwrap();
        let n = std::fs::read_dir(&bk).unwrap().count();
        assert_eq!(n, MAX_BACKUPS);
    }
}
