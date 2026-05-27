mod claude_bin;
mod claude_md;
mod commands;
mod jsonl_watcher;
mod log;
mod pty;
mod state;
mod storage;

use tauri::Manager;

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
        .plugin(tauri_plugin_notification::init())
        // Updater + process plugins disabled on Windows ARM64 (ring needs
        // clang). Re-enable after `winget install LLVM.LLVM` — see
        // Cargo.toml note.
        .manage(app_state)
        .manage(crate::pty::TerminalManager::new())
        .manage(crate::commands::terminals::WatcherRegistry::default())
        .manage(crate::commands::notifications::NotificationsWatcher(
            std::sync::Mutex::new(None),
        ))
        .manage(crate::commands::schedules::SchedulesState::new())
        .manage(crate::commands::chat::ChatManager::new())
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
            commands::fs::stash_dropped_file,
            commands::fs::stash_paste_as_attachment,
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
            commands::scrollback::jsonl_mtime_ms,
            commands::dashboard::dashboard_path,
            commands::dashboard::read_session_dashboard,
            commands::dashboard::write_session_dashboard,
            commands::dashboard::dashboard_mtime_ms,
            commands::processes::list_processes,
            commands::processes::kill_process,
            commands::chrome::open_chrome,
            commands::chrome::open_external_url,
            commands::memory::read_project_memory,
            commands::memory::write_project_memory,
            commands::memory::read_global_memory,
            commands::memory::write_global_memory,
            commands::config::read_global_config,
            commands::config::write_global_config,
            commands::usage::read_claude_usage,
            commands::usage::read_claude_subscription,
            commands::usage::read_claude_daily_activity,
            commands::usage::read_claude_usage_limits,
            commands::usage_snapshot::read_claude_usage_snapshot,
            commands::skills::list_skills,
            commands::skills::set_skill_enabled,
            commands::skills::read_skill_file,
            commands::skills::install_skill_from_text,
            commands::skills::install_skill_from_path,
            commands::skills::delete_skill,
            commands::voice::transcribe_audio,
            commands::notifications::notify_user,
            commands::notifications::list_recent_notifications,
            commands::schedules::list_schedules,
            commands::schedules::create_schedule,
            commands::schedules::update_schedule,
            commands::schedules::delete_schedule,
            commands::schedules::run_schedule_now,
            commands::chat::chat_spawn,
            commands::chat::chat_send_user_text,
            commands::chat::chat_send_user_with_attachments,
            commands::chat::chat_send_tool_result,
            commands::chat::chat_switch_model,
            commands::chat::chat_set_session_id,
            commands::chat::chat_load_history,
            commands::chat::chat_interrupt,
            commands::chat::chat_interrupt_and_resume,
            commands::chat::chat_kill,
            commands::chat::read_session_excerpt,
            commands::chat::list_resumable_sessions,
            commands::chat::rewind_session,
            commands::chat::chat_fork_at_uuid,
            commands::chat::chat_resume_other_session,
            commands::chat::append_to_claude_md,
            commands::chat::read_project_coach_state,
            commands::chat::write_project_coach_state,
            commands::chat::read_project_coach_messages,
            commands::chat::write_project_coach_messages,
            commands::chat::read_global_coach_state,
            commands::chat::write_global_coach_state,
            commands::chat::read_global_coach_messages,
            commands::chat::write_global_coach_messages,
            commands::chat::coach_workspace_path,
            commands::workflows::workflows_path,
            commands::workflows::list_workflows,
            commands::workflows::create_workflow,
            commands::workflows::update_workflow,
            commands::workflows::delete_workflow,
            commands::workflows::list_workflow_runs,
            commands::workflows::append_workflow_run,
            commands::variables::variables_path,
            commands::variables::list_variables,
            commands::variables::set_variable,
            commands::variables::delete_variable,
        ])
        .setup(|app| {
            // Spawn the notifications watcher tied to the app handle so it
            // can emit events to the webview. Runs until app shutdown.
            crate::commands::notifications::start_watcher(app.handle().clone());
            // Background scheduler thread: ticks every 5s and fires due
            // jobs via TerminalManager.
            crate::commands::schedules::start_scheduler(app.handle().clone());
            // Background reaper: every 60s, kill chat sessions that have
            // been idle (no user input AND no claude output) for longer
            // than the timeout. The user reported load avg 100+ from
            // 11 stale claude children accumulating in one app instance
            // — this is the safety net. Override default 30 min via
            // DEEPTHIX_IDLE_TIMEOUT_MS env var; <=0 disables.
            crate::commands::chat::start_idle_reaper(
                app.handle().clone(),
                crate::commands::chat::idle_timeout_ms(),
            );
            // Make sure every claude session knows about Deepthix's env
            // hooks (workflows, dashboard, project_id) by appending the
            // brief to ~/.claude/CLAUDE.md. Idempotent — markered block.
            if let Err(e) = crate::claude_md::ensure_global_brief() {
                tracing::warn!(
                    target: "deepthix::boot",
                    error = %e,
                    "ensure_global_brief failed (claude won't auto-discover env hooks)"
                );
            }
            tracing::info!(target: "deepthix::boot", "tauri setup complete");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // App-exit hook: kill every spawned claude (chat + pty) so
            // children don't get re-parented to launchd and outlive the
            // app. The user reported finding orphan claudes from
            // previous sessions still consuming CPU 2 days later — this
            // is the fix.
            if let tauri::RunEvent::Exit = event {
                tracing::info!(target: "deepthix::boot", "exit event — killing all children");
                if let Some(state) = app.try_state::<crate::commands::chat::ChatManager>() {
                    state.kill_all_blocking();
                }
                if let Some(state) = app.try_state::<crate::pty::TerminalManager>() {
                    state.kill_all_blocking();
                }
            }
        });
}
