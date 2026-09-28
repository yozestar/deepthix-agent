use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

/// Reads a JSON file at `path`, deserializing to `T`. Returns `Ok(None)` if
/// the file doesn't exist; `Err` for any other I/O or parse failure.
pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> std::io::Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value = serde_json::from_slice(&bytes).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, e)
            })?;
            Ok(Some(value))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Atomically writes `value` as pretty-printed JSON to `path`. Creates parent
/// dirs if needed. Uses `<path>.tmp` + rename so a crash mid-write leaves the
/// previous file intact.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e)
    })?;
    let tmp = path.with_extension(
        path.extension().and_then(|e| e.to_str()).map(|e| format!("{e}.tmp")).unwrap_or_else(|| "tmp".into())
    );
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, path)?;
    tracing::debug!(target: "deepthix::storage", ?path, bytes = bytes.len(), "wrote json");
    Ok(())
}

/// App data folder under the home dir. Elyone keeps its own folder so it
/// can run side by side with Deepthix Agent v2, which owns `~/.deepthix`
/// (see `migration.rs` for the re-runnable copy from that folder).
pub const DATA_DIR_NAME: &str = ".elyone";
/// Legacy Deepthix data folder — only ever READ (import source).
pub const LEGACY_DATA_DIR_NAME: &str = ".deepthix";

/// `<home>/.elyone` for an explicit home path (no filesystem access).
pub fn data_dir_in(home: impl AsRef<std::path::Path>) -> PathBuf {
    home.as_ref().join(DATA_DIR_NAME)
}

/// `~/.elyone`, or None when the home dir can't be resolved. Uses the OS
/// profile dir, not `$HOME` (often unset for GUI apps on Windows).
pub fn data_root() -> Option<PathBuf> {
    dirs::home_dir().map(data_dir_in)
}

/// Returns `~/.elyone/`, creating it if absent.
pub fn deepthix_dir() -> std::io::Result<PathBuf> {
    let dir = data_root()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Returns `~/.elyone/projects/<id>/`, creating it if absent.
pub fn project_dir(id: &str) -> std::io::Result<PathBuf> {
    let dir = deepthix_dir()?.join("projects").join(id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::tempdir;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Foo {
        n: i32,
        s: String,
    }

    #[test]
    fn read_json_returns_none_when_file_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing.json");
        let result: Option<Foo> = read_json(&path).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("foo.json");
        let value = Foo { n: 42, s: "hello".into() };
        write_json(&path, &value).unwrap();
        let loaded: Option<Foo> = read_json(&path).unwrap();
        assert_eq!(loaded, Some(value));
    }

    #[test]
    fn write_creates_parent_dirs() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a/b/c/foo.json");
        let value = Foo { n: 1, s: "x".into() };
        write_json(&nested, &value).unwrap();
        assert!(nested.exists());
    }

    #[test]
    fn write_is_atomic_via_tmp_rename() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("foo.json");
        // Pre-existing file with old contents.
        std::fs::write(&path, br#"{"n":1,"s":"old"}"#).unwrap();
        let new_value = Foo { n: 2, s: "new".into() };
        write_json(&path, &new_value).unwrap();
        // No leftover .tmp.
        let entries: Vec<_> = std::fs::read_dir(dir.path()).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(!entries.iter().any(|n| n.ends_with(".tmp")), "leftover tmp: {:?}", entries);
        let loaded: Foo = read_json(&path).unwrap().unwrap();
        assert_eq!(loaded.n, 2);
    }

    #[test]
    fn deepthix_dir_is_under_home() {
        let path = deepthix_dir().unwrap();
        assert!(path.ends_with(".elyone"), "got {:?}", path);
        assert!(path.is_dir());
    }

    #[test]
    fn project_dir_is_created_under_deepthix_projects() {
        let dir = project_dir("abc123").unwrap();
        assert!(dir.ends_with("projects/abc123"), "got {:?}", dir);
        assert!(dir.is_dir());
    }
}
