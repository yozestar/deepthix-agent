// Mirror of Rust's serde-serialized types from src-tauri/src/state.rs
// and src-tauri/src/commands/fs.rs.

export interface Project {
  id: string;
  path: string;
  name: string;
  last_opened_unix_ms: number;
}

export interface ProjectsFile {
  projects: Project[];
  active_project_id: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
}

export interface SwitchResult {
  ok: boolean;
}
