//! Replays a command coming from a remote client through the main
//! webview's own invoke pipeline, so every `#[tauri::command]` registered
//! in `lib.rs` is reachable without per-command glue.

use serde_json::Value;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Manager, Runtime, Webview};

/// Commands a remote client may call: everything registered in `lib.rs`
/// except desktop-only ones (native dialogs, dropped files, opening apps on
/// the PC) and every `remote_*` admin command. Keep in sync with lib.rs.
const REMOTE_COMMANDS: &[&str] = &[
    "add_project",
    "list_projects",
    "switch_project",
    "remove_project",
    "rename_project",
    "list_dir",
    "read_file",
    "write_file",
    "file_kind",
    "home_dir",
    "file_size",
    "read_file_bytes_base64",
    "stash_paste_as_attachment",
    "save_open_files",
    "load_open_files",
    "save_layout",
    "load_layout",
    "spawn_terminal",
    "pty_write",
    "pty_resize",
    "kill_terminal",
    "save_sessions",
    "load_sessions",
    "save_closed_sessions",
    "load_closed_sessions",
    "save_terminal_scrollback",
    "load_terminal_scrollback",
    "clear_terminal_scrollback",
    "jsonl_mtime_ms",
    "session_previews",
    "search_conversations",
    "move_session",
    "legacy_import_status",
    "import_from_deepthix",
    "dashboard_path",
    "read_session_dashboard",
    "write_session_dashboard",
    "dashboard_mtime_ms",
    "list_processes",
    "kill_process",
    "read_project_memory",
    "write_project_memory",
    "read_global_memory",
    "write_global_memory",
    "read_global_config",
    "write_global_config",
    "read_claude_usage",
    "read_claude_subscription",
    "read_claude_daily_activity",
    "read_claude_usage_limits",
    "read_claude_usage_snapshot",
    "list_skills",
    "set_skill_enabled",
    "read_skill_file",
    "install_skill_from_text",
    "delete_skill",
    "transcribe_audio",
    "notify_user",
    "list_recent_notifications",
    "list_schedules",
    "create_schedule",
    "update_schedule",
    "delete_schedule",
    "run_schedule_now",
    "chat_spawn",
    "chat_send_user_text",
    "chat_send_user_with_attachments",
    "chat_send_tool_result",
    "chat_switch_model",
    "chat_set_session_id",
    "chat_load_history",
    "chat_interrupt",
    "chat_interrupt_and_resume",
    "chat_kill",
    "read_session_excerpt",
    "list_resumable_sessions",
    "rewind_session",
    "chat_fork_at_uuid",
    "chat_resume_other_session",
    "append_to_claude_md",
    "read_project_coach_state",
    "write_project_coach_state",
    "read_project_coach_messages",
    "write_project_coach_messages",
    "read_global_coach_state",
    "write_global_coach_state",
    "read_global_coach_messages",
    "write_global_coach_messages",
    "coach_workspace_path",
    "workflows_path",
    "list_workflows",
    "create_workflow",
    "update_workflow",
    "delete_workflow",
    "list_workflow_runs",
    "append_workflow_run",
    "variables_path",
    "list_variables",
    "set_variable",
    "delete_variable",
];

pub fn is_remote_allowed(cmd: &str) -> bool {
    REMOTE_COMMANDS.contains(&cmd)
}

pub async fn dispatch<R: Runtime>(app: &AppHandle<R>, cmd: &str, args: Value) -> Result<Value, String> {
    if !is_remote_allowed(cmd) {
        return Err(format!("command not allowed remotely: {cmd}"));
    }
    invoke_through_webview(app, cmd, args).await
}

async fn invoke_through_webview<R: Runtime>(
    app: &AppHandle<R>,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window unavailable".to_string())?;
    let webview: Webview<R> = window.as_ref().clone();
    let url = webview.url().map_err(|e| e.to_string())?;

    let request = InvokeRequest {
        cmd: cmd.to_string(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url,
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: app.invoke_key().to_string(),
    };

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Value, String>>();
    webview.on_message(
        request,
        Box::new(move |_webview, _cmd, response, _callback, _error| {
            let _ = tx.send(response_to_result(response));
        }),
    );
    rx.await
        .map_err(|_| format!("command {cmd} dropped without a response"))?
}

fn response_to_result(response: InvokeResponse) -> Result<Value, String> {
    match response {
        InvokeResponse::Ok(InvokeResponseBody::Json(s)) => {
            serde_json::from_str(&s).map_err(|e| e.to_string())
        }
        InvokeResponse::Ok(InvokeResponseBody::Raw(bytes)) => {
            Ok(Value::Array(bytes.into_iter().map(Value::from).collect()))
        }
        InvokeResponse::Err(e) => Err(match e.0 {
            Value::String(s) => s,
            other => other.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tauri::command]
    fn echo_len(some_text: String) -> usize {
        some_text.len()
    }

    #[tauri::command]
    fn always_fails() -> Result<(), String> {
        Err("boom".into())
    }

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![echo_len, always_fails])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("main window");
        app
    }

    #[test]
    fn allows_chat_and_terminal() {
        for c in ["chat_send_user_text", "pty_write", "list_projects", "read_file", "home_dir"] {
            assert!(is_remote_allowed(c), "{c}");
        }
    }

    #[test]
    fn denies_desktop_only() {
        for c in ["open_folder", "stash_dropped_file", "open_chrome", "open_external_url", "install_skill_from_path"] {
            assert!(!is_remote_allowed(c), "{c}");
        }
    }

    #[test]
    fn denies_remote_admin() {
        for c in [
            "remote_set_enabled",
            "remote_revoke_device",
            "remote_pair_respond",
            "remote_get_status",
            "remote_set_autostart",
        ] {
            assert!(!is_remote_allowed(c), "{c}");
        }
    }

    #[test]
    fn whitelist_only_names_registered_commands() {
        let lib = include_str!("../lib.rs");
        for c in REMOTE_COMMANDS {
            assert!(lib.contains(&format!("::{c},")), "{c} is not registered in lib.rs");
        }
    }

    #[test]
    fn denies_unknown() {
        assert!(!is_remote_allowed("rm_rf"));
        assert!(!is_remote_allowed(""));
    }

    #[tokio::test]
    async fn dispatch_rejects_command_not_allowed_remotely() {
        let app = app();
        let out = dispatch(app.handle(), "open_folder", json!({})).await;
        assert_eq!(out, Err("command not allowed remotely: open_folder".to_string()));
    }

    #[tokio::test]
    async fn dispatch_runs_registered_command_with_camel_case_args() {
        let app = app();
        let out = invoke_through_webview(app.handle(), "echo_len", json!({ "someText": "hello" })).await;
        assert_eq!(out, Ok(json!(5)));
    }

    #[tokio::test]
    async fn dispatch_surfaces_command_error() {
        let app = app();
        let out = invoke_through_webview(app.handle(), "always_fails", json!({})).await;
        assert_eq!(out, Err("boom".to_string()));
    }
}
