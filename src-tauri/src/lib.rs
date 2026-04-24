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
            commands::fs::list_dir,
            commands::layout::save_layout,
            commands::layout::load_layout,
            commands::terminals::spawn_terminal,
            commands::terminals::pty_write,
            commands::terminals::pty_resize,
            commands::terminals::kill_terminal,
            commands::sessions::save_sessions,
            commands::sessions::load_sessions,
            commands::processes::list_processes,
            commands::processes::kill_process,
        ])
        .setup(|_app| {
            tracing::info!(target: "deepthix::boot", "tauri setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
