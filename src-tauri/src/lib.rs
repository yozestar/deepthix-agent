mod commands;
mod log;
mod state;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _log_guard = log::init();
    tracing::info!(
        target: "deepthix::boot",
        version = env!("CARGO_PKG_VERSION"),
        "starting Deepthix Agent"
    );

    tauri::Builder::default()
        .setup(|_app| {
            // `log::*` calls from Tauri internals (and any other dep using
            // the `log` facade) are bridged into our tracing subscriber by
            // `tracing_log::LogTracer::init()` in `log::init()`, so they
            // land in the same unified file as native tracing events.
            tracing::info!(target: "deepthix::boot", "tauri setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
