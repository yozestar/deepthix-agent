use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub is_hidden: bool,
}

const EXCLUDE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "target",
    ".deepthix",
    ".next",
    ".turbo",
    ".cache",
];

#[tauri::command]
pub fn list_dir(path: PathBuf) -> Result<Vec<FileEntry>, String> {
    tracing::debug!(target: "deepthix::commands", ?path, "list_dir");
    list_dir_inner(&path).map_err(|e| e.to_string())
}

/// Read a UTF-8 text file. Returns the full contents as a String. The caller
/// is expected to have already checked file_kind/size so we don't accidentally
/// stream a 200MB log file across the bridge.
#[tauri::command]
pub fn read_file(path: PathBuf) -> Result<String, String> {
    tracing::debug!(target: "deepthix::commands", ?path, "read_file");
    std::fs::read_to_string(&path).map_err(|e| {
        tracing::warn!(target: "deepthix::commands", ?path, error = %e, "read_file failed");
        e.to_string()
    })
}

/// Overwrite a text file with `content`. Used by the Files pane editor save.
#[tauri::command]
pub fn write_file(path: PathBuf, content: String) -> Result<(), String> {
    tracing::info!(target: "deepthix::commands", ?path, bytes = content.len(), "write_file");
    std::fs::write(&path, content).map_err(|e| {
        tracing::warn!(target: "deepthix::commands", ?path, error = %e, "write_file failed");
        e.to_string()
    })
}

/// Returns true if the file looks like a text file based on extension.
/// Used to decide whether to fetch contents or treat as binary/image.
#[tauri::command]
pub fn file_kind(path: PathBuf) -> Result<&'static str, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let kind = match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "bmp" => "image",
        "mp4" | "mov" | "webm" | "avi" => "video",
        "pdf" => "pdf",
        "" | "txt" | "md" | "json" | "ts" | "tsx" | "js" | "jsx" | "rs" | "py" | "go" | "java"
        | "kt" | "swift" | "c" | "cpp" | "h" | "hpp" | "css" | "scss" | "html" | "yaml" | "yml"
        | "toml" | "xml" | "sh" | "bash" | "zsh" | "fish" | "rb" | "php" | "lua" | "vue"
        | "svelte" | "astro" | "mdx" | "ini" | "conf" | "log" | "sql" | "graphql" | "gql"
        | "env" | "gitignore" | "lock" | "csv" | "tsv" => "text",
        _ => "unknown",
    };
    tracing::debug!(target: "deepthix::commands", ?path, kind, "file_kind");
    Ok(kind)
}

/// Read the bytes of an image (or any binary) and return base64 + mime so the
/// webview can render it without going through a Tauri asset URL.
#[tauri::command]
pub fn read_file_bytes_base64(path: PathBuf) -> Result<(String, String), String> {
    use base64::Engine;
    tracing::debug!(target: "deepthix::commands", ?path, "read_file_bytes_base64");
    let bytes = std::fs::read(&path).map_err(|e| {
        tracing::warn!(target: "deepthix::commands", ?path, error = %e, "read_file_bytes_base64 failed");
        e.to_string()
    })?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
    .to_string();
    Ok((b64, mime))
}

/// Returns the file size in bytes. Used by the Files pane to gate large-file
/// loads behind a confirmation prompt (so opening a giant log doesn't hang).
#[tauri::command]
pub fn file_size(path: PathBuf) -> Result<u64, String> {
    tracing::debug!(target: "deepthix::commands", ?path, "file_size");
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta.len())
}

fn list_dir_inner(path: &Path) -> std::io::Result<Vec<FileEntry>> {
    let mut entries: Vec<FileEntry> = std::fs::read_dir(path)?
        .filter_map(|res| {
            let entry = res.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let entry_path = entry.path();
            let is_dir = entry.file_type().ok()?.is_dir();
            let is_hidden = name.starts_with('.');
            if is_dir && EXCLUDE_DIRS.contains(&name.as_str()) {
                return None;
            }
            Some(FileEntry { name, path: entry_path, is_dir, is_hidden })
        })
        .collect();
    // Dirs first, then files; alphabetical within each group.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Copy a file the user dragged into the window to a stable location
/// under `~/.deepthix/dropped/<uuid>.<ext>` and return the new path.
///
/// Why: macOS's screenshot thumbnail (the floating preview after
/// Cmd+Shift+4) hands the webview a path inside
/// `/var/folders/.../TemporaryItems/NSIRD_screencaptureui_*/...png`
/// that the OS deletes the moment the drag finishes. Claude reads the
/// file ~1 s later and gets ENOENT. By snapshotting the bytes during
/// the drop event — when the file is still alive — we give claude a
/// path that survives.
///
/// Always copies, even for paths that look stable. Cheap (the dropped
/// files are small) and avoids second-guessing the OS's lifetime
/// rules. Returns the absolute path of the snapshot.
#[tauri::command]
pub fn stash_dropped_file(src: PathBuf) -> Result<PathBuf, String> {
    tracing::debug!(target: "deepthix::commands", ?src, "stash_dropped_file");
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dst_dir = home.join(".deepthix").join("dropped");
    std::fs::create_dir_all(&dst_dir)
        .map_err(|e| format!("create dropped dir: {e}"))?;

    // Build a filename that preserves the original extension (so claude
    // knows it's a .png / .pdf / etc.) but uses a fresh uuid prefix so
    // multiple drops don't collide. We deliberately KEEP the original
    // basename (after the uuid) so the user can still see what they
    // dragged in if they later browse ~/.deepthix/dropped/.
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_string();
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        // Strip the macOS screenshot prefix so it doesn't bloat the path.
        // "Capture d'écran 2026-04-27 à 10.39.18" → keep the timestamp suffix
        // but drop the locale prefix.
        .replace(' ', "_");
    let id = uuid::Uuid::new_v4().to_string();
    // Keep the uuid short (first segment) — the dir is opaque to the
    // user anyway; what matters is the extension survives.
    let short = id.split('-').next().unwrap_or(&id);
    let dst = dst_dir.join(format!("{short}_{stem}.{ext}"));

    std::fs::copy(&src, &dst).map_err(|e| {
        tracing::warn!(target: "deepthix::commands", ?src, ?dst, error = %e, "stash_dropped_file copy failed");
        format!("copy: {e}")
    })?;
    tracing::info!(target: "deepthix::commands", ?src, ?dst, "stash_dropped_file ok");
    Ok(dst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn lists_files_and_dirs_with_dirs_first() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("zebra.txt"), b"").unwrap();
        std::fs::write(dir.path().join("apple.txt"), b"").unwrap();
        std::fs::create_dir(dir.path().join("subdir")).unwrap();
        let entries = list_dir_inner(dir.path()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["subdir", "apple.txt", "zebra.txt"]);
    }

    #[test]
    fn excludes_node_modules_and_git_etc() {
        let dir = tempdir().unwrap();
        for excluded in &["node_modules", ".git", "dist", "target", ".deepthix"] {
            std::fs::create_dir(dir.path().join(excluded)).unwrap();
        }
        std::fs::create_dir(dir.path().join("src")).unwrap();
        let entries = list_dir_inner(dir.path()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src"]);
    }

    #[test]
    fn marks_hidden_dotfiles_but_keeps_them() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), b"").unwrap();
        std::fs::write(dir.path().join("README.md"), b"").unwrap();
        let entries = list_dir_inner(dir.path()).unwrap();
        assert_eq!(entries.len(), 2);
        let env = entries.iter().find(|e| e.name == ".env").unwrap();
        assert!(env.is_hidden);
        let readme = entries.iter().find(|e| e.name == "README.md").unwrap();
        assert!(!readme.is_hidden);
    }

    #[test]
    fn returns_err_when_path_does_not_exist() {
        let result = list_dir_inner(Path::new("/definitely/does/not/exist/xyz123"));
        assert!(result.is_err());
    }

    #[test]
    fn read_file_returns_contents() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, "hi there").unwrap();
        let result = read_file(path).unwrap();
        assert_eq!(result, "hi there");
    }

    #[test]
    fn write_file_persists_contents() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("out.txt");
        write_file(path.clone(), "saved!".into()).unwrap();
        let read = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read, "saved!");
    }

    #[test]
    fn file_kind_classifies_known_extensions() {
        assert_eq!(file_kind(PathBuf::from("foo.png")).unwrap(), "image");
        assert_eq!(file_kind(PathBuf::from("foo.PDF")).unwrap(), "pdf");
        assert_eq!(file_kind(PathBuf::from("foo.ts")).unwrap(), "text");
        assert_eq!(file_kind(PathBuf::from("foo.mp4")).unwrap(), "video");
        assert_eq!(file_kind(PathBuf::from("Makefile")).unwrap(), "text"); // no ext → text
        assert_eq!(file_kind(PathBuf::from("foo.bin")).unwrap(), "unknown");
    }

    #[test]
    fn read_file_bytes_base64_returns_payload_and_mime() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("img.png");
        std::fs::write(&path, b"\x89PNG-fake").unwrap();
        let (b64, mime) = read_file_bytes_base64(path).unwrap();
        assert_eq!(mime, "image/png");
        assert!(!b64.is_empty());
    }

    #[test]
    fn file_size_returns_bytes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("foo.txt");
        std::fs::write(&path, "12345").unwrap();
        assert_eq!(file_size(path).unwrap(), 5);
    }
}
