mod log;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _log_guard = log::init();
    tracing::info!(
        target: "deepthix::boot",
        version = env!("CARGO_PKG_VERSION"),
        "starting Deepthix Agent"
    );

    tauri::Builder::default()
        .setup(|app| {
            // Preserved from `tauri init` scaffold — registers the
            // `tauri-plugin-log` plugin in debug builds. We use `tracing`
            // for our own logging (see `log.rs`); this plugin is left in
            // place for any future Tauri-internal log plumbing.
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(::log::LevelFilter::Info)
                        .build(),
                )?;
            }
            tracing::info!(target: "deepthix::boot", "tauri setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
