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
    // Retention policy: keep at most 7 daily log files. Without this,
    // a long-lived install accumulates ~50 MB/day forever (one user
    // hit 403 MB total before manual cleanup). max_log_files prunes
    // on rotation; the boot-time fallback below catches files written
    // by older versions that never had the retention setting.
    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("deepthix")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&log_dir)
        .expect("build rolling file appender");
    prune_old_logs(&log_dir, 7);
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
        .join(crate::storage::DATA_DIR_NAME)
        .join("logs")
}

/// Delete log files older than `keep_days` days. Belt-and-suspenders for
/// the rolling appender's max_log_files: catches files left behind by
/// older builds and absorbs cases where the user manually copied old
/// logs back into the dir.
fn prune_old_logs(log_dir: &std::path::Path, keep_days: u64) {
    let cutoff = match std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(keep_days * 24 * 3600))
    {
        Some(t) => t,
        None => return,
    };
    let entries = match std::fs::read_dir(log_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut pruned = 0usize;
    let mut bytes = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta.modified().unwrap_or(std::time::SystemTime::now());
        if modified < cutoff {
            bytes += meta.len();
            if std::fs::remove_file(&path).is_ok() {
                pruned += 1;
            }
        }
    }
    if pruned > 0 {
        eprintln!(
            "[deepthix] pruned {pruned} old log file(s) ({} MB)",
            bytes / 1_048_576
        );
    }
}
