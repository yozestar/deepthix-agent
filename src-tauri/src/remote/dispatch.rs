//! Replays a command coming from a remote client through the main
//! webview's own invoke pipeline, so every `#[tauri::command]` registered
//! in `lib.rs` is reachable without per-command glue.

use serde_json::Value;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Manager, Runtime, Webview};

pub async fn dispatch<R: Runtime>(app: &AppHandle<R>, cmd: &str, args: Value) -> Result<Value, String> {
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

    #[tokio::test]
    async fn dispatch_runs_registered_command_with_camel_case_args() {
        let app = app();
        let out = dispatch(app.handle(), "echo_len", json!({ "someText": "hello" })).await;
        assert_eq!(out, Ok(json!(5)));
    }

    #[tokio::test]
    async fn dispatch_surfaces_command_error() {
        let app = app();
        let out = dispatch(app.handle(), "always_fails", json!({})).await;
        assert_eq!(out, Err("boom".to_string()));
    }
}
