use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

/// Initializes tracing to log to stderr AND to a daily-rotated file at
/// `~/.deepthix/logs/deepthix.YYYY-MM-DD.log`. Returns the worker guard;
/// the caller MUST keep it alive for the program lifetime, otherwise
/// the file logger is dropped.
pub fn init() -> WorkerGuard {
    // Note: `tracing-subscriber` 0.3 ships with the `tracing-log` feature
    // enabled by default — its `init()` call below installs the
    // `log` -> `tracing` bridge for us. We deliberately do NOT call
    // `LogTracer::init()` ourselves here, because the global `log` logger
    // can only be set once, and a duplicate install panics with
    // `SetLoggerError` before any tracing event ever runs.

    let log_dir = log_dir();
    std::fs::create_dir_all(&log_dir).expect("create log dir");

    // `tracing_appender::rolling::daily(prefix)` produces `prefix.<date>`
    // (no extension at the end). We use the Builder to get
    // `deepthix.<date>.log` (extension last) — closest the library
    // supports without writing a custom writer.
    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("deepthix")
        .filename_suffix("log")
        .build(&log_dir)
        .expect("build rolling file appender");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = EnvFilter::try_from_env("DEEPTHIX_LOG")
        .or_else(|_| EnvFilter::try_new("info,deepthix=debug"))
        .unwrap();

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt::layer().with_target(true).with_writer(std::io::stderr))
        .with(fmt::layer().with_target(true).with_ansi(false).with_writer(file_writer))
        .init();

    tracing::info!(target: "deepthix::boot", path = ?log_dir, "logging initialized");
    guard
}

pub fn log_dir() -> PathBuf {
    dirs::home_dir()
        .expect("home dir")
        .join(".deepthix")
        .join("logs")
}
