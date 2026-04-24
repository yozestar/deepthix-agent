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
}
