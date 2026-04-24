use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

/// Initializes tracing to log to stderr AND to a daily-rotated file at
/// `~/.deepthix/logs/deepthix.log.YYYY-MM-DD`. Returns the worker guard;
/// the caller MUST keep it alive for the program lifetime, otherwise
/// the file logger is dropped.
pub fn init() -> WorkerGuard {
    let log_dir = log_dir();
    std::fs::create_dir_all(&log_dir).expect("create log dir");

    let file_appender = tracing_appender::rolling::daily(&log_dir, "deepthix.log");
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
