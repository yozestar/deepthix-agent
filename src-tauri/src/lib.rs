mod claude_md;
mod commands;
mod jsonl_watcher;
mod log;
mod pty;
mod state;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _log_guard = log::init();
    tracing::info!(target: "deepthix::boot", version = env!("CARGO_PKG_VERSION"), "starting Deepthix Agent");

    let projects_path = match storage::deepthix_dir() {
        Ok(dir) => dir.join("projects.json"),
        Err(e) => {
            tracing::error!(target: "deepthix::boot", error = %e, "failed to resolve ~/.deepthix/");
            std::process::exit(1);
        }
    };
    let app_state = match state::AppState::load(projects_path.clone()) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(target: "deepthix::boot", error = %e, path = ?projects_path, "failed to load projects.json");
            std::process::exit(1);
        }
    };

    // Migration: ensure every PRE-EXISTING project's CLAUDE.md teaches the
    // dashboard convention. New projects get this on add (commands/projects.rs);
    // this loop catches everything that was added before that wiring existed.
    // Best-effort — any per-project failure is logged and skipped.
    for project in app_state.snapshot().projects {
        match claude_md::inject_into_project(&project.path) {
            Ok(true) => tracing::info!(
                target: "deepthix::boot",
                id = %project.id, name = %project.name, path = ?project.path,
                "CLAUDE.md dashboard block injected/updated",
            ),
            Ok(false) => {} // already up to date
            Err(e) => tracing::warn!(
                target: "deepthix::boot",
                id = %project.id, name = %project.name, error = %e,
                "CLAUDE.md inject failed for existing project (skipping)",
            ),
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .manage(crate::pty::TerminalManager::new())
        .manage(crate::commands::terminals::WatcherRegistry::default())
        .invoke_handler(tauri::generate_handler![
            commands::projects::open_folder,
            commands::projects::add_project,
            commands::projects::list_projects,
            commands::projects::switch_project,
            commands::projects::remove_project,
            commands::projects::rename_project,
            commands::fs::list_dir,
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::file_kind,
            commands::fs::file_size,
            commands::fs::read_file_bytes_base64,
            commands::open_files::save_open_files,
            commands::open_files::load_open_files,
            commands::layout::save_layout,
            commands::layout::load_layout,
            commands::terminals::spawn_terminal,
            commands::terminals::pty_write,
            commands::terminals::pty_resize,
            commands::terminals::kill_terminal,
            commands::sessions::save_sessions,
            commands::sessions::load_sessions,
            commands::scrollback::save_terminal_scrollback,
            commands::scrollback::load_terminal_scrollback,
            commands::scrollback::clear_terminal_scrollback,
            commands::dashboard::dashboard_path,
            commands::dashboard::read_session_dashboard,
            commands::dashboard::write_session_dashboard,
            commands::dashboard::dashboard_mtime_ms,
            commands::processes::list_processes,
            commands::processes::kill_process,
            commands::chrome::open_chrome,
            commands::memory::read_project_memory,
            commands::memory::write_project_memory,
            commands::memory::read_global_memory,
            commands::memory::write_global_memory,
            commands::config::read_global_config,
            commands::config::write_global_config,
        ])
        .setup(|_app| {
            tracing::info!(target: "deepthix::boot", "tauri setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
