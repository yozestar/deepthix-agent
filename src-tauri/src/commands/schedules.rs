// Schedule jobs: "this session, do this prompt, at this time / every N seconds".
//
// Storage: ~/.deepthix/schedules.json (a single JSON array of Schedule).
//
// Scheduler: a single std::thread spawned at app startup that ticks every
// SCHEDULER_TICK_MS, scans every non-paused job, and fires those whose
// next_run_ms <= now. "Fire" means:
//   1. Resolve the schedule's session_id → live terminal id via
//      TerminalManager::find_term_by_session.
//   2. ptyWrite(prompt + "\r") so claude code receives + submits it.
//   3. Push a deepthix-notification so the user sees what just ran.
//   4. Update last_run_ms + recompute next_run_ms (or mark `paused = true`
//      if it was a one-shot Once cadence).
//   5. Persist the JSON file.
//
// If the target session is not currently spawned (only persisted on
// disk), we fire a warn notification and skip — auto-respawn would be
// nice but adds a lot of state-machine surface, so v1 just nudges the
// user to open the session first.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::chat::ChatManager;
use crate::pty::TerminalManager;

const SCHEDULER_TICK_MS: u64 = 5_000;

// ─── Types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Cadence {
    /// One-shot at the given wall-clock millis. After firing, the job
    /// is auto-paused (kept around so the user can see it ran).
    Once { at_ms: u64 },
    /// Repeating every N seconds. next_run_ms advances by N each fire.
    Interval { every_seconds: u64 },
}

impl Cadence {
    /// Compute the timestamp at which this cadence should next fire,
    /// given that it just fired at `now_ms`. Returns None for one-shots
    /// (caller pauses the job).
    fn advance_after(&self, now_ms: u64) -> Option<u64> {
        match self {
            Cadence::Once { .. } => None,
            Cadence::Interval { every_seconds } => Some(now_ms + every_seconds * 1000),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    /// Stable claude session UUID — survives app restarts. The live
    /// term_id is looked up at fire time.
    pub target_session_id: String,
    pub target_project_id: String,
    /// Free-form text injected into the session's prompt, with trailing
    /// CR appended at fire time.
    pub prompt: String,
    pub cadence: Cadence,
    /// User can pause without deleting. Paused jobs aren't scheduled.
    pub paused: bool,
    /// Wall-clock millis of the last successful fire. None if never fired.
    pub last_run_ms: Option<u64>,
    /// Wall-clock millis of the next scheduled fire. For paused jobs
    /// this is whatever it was at pause time — re-evaluated on resume.
    pub next_run_ms: u64,
    pub created_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateScheduleArgs {
    pub name: String,
    pub target_session_id: String,
    pub target_project_id: String,
    pub prompt: String,
    pub cadence: Cadence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateScheduleArgs {
    pub id: String,
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub cadence: Option<Cadence>,
    pub paused: Option<bool>,
}

// ─── Storage ─────────────────────────────────────────────────────────────

fn schedules_path() -> std::io::Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| std::io::Error::other("no home dir"))?;
    Ok(home.join(crate::storage::DATA_DIR_NAME).join("schedules.json"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_from_disk() -> Vec<Schedule> {
    let path = match schedules_path() {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_to_disk(schedules: &[Schedule]) -> std::io::Result<()> {
    let path = schedules_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(schedules)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

// ─── State ───────────────────────────────────────────────────────────────

/// Tauri-managed state holding the in-memory job list. Mutex-locked so
/// commands and the scheduler thread can both touch it.
pub struct SchedulesState(pub Arc<Mutex<Vec<Schedule>>>);

impl SchedulesState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(load_from_disk())))
    }
}

// ─── Tauri commands ──────────────────────────────────────────────────────

#[tauri::command]
pub fn list_schedules(state: State<'_, SchedulesState>) -> Vec<Schedule> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn create_schedule(
    state: State<'_, SchedulesState>,
    args: CreateScheduleArgs,
) -> Result<Schedule, String> {
    let now = now_ms();
    // Compute the initial next_run_ms based on cadence.
    let next_run_ms = match &args.cadence {
        Cadence::Once { at_ms } => *at_ms,
        Cadence::Interval { every_seconds } => now + every_seconds * 1000,
    };
    let s = Schedule {
        id: uuid::Uuid::new_v4().to_string(),
        name: args.name.trim().to_string(),
        target_session_id: args.target_session_id,
        target_project_id: args.target_project_id,
        prompt: args.prompt,
        cadence: args.cadence,
        paused: false,
        last_run_ms: None,
        next_run_ms,
        created_ms: now,
    };
    let mut list = state.0.lock().unwrap();
    list.push(s.clone());
    save_to_disk(&list).map_err(|e| e.to_string())?;
    tracing::info!(target: "deepthix::schedules", id = %s.id, name = %s.name, "created");
    Ok(s)
}

#[tauri::command]
pub fn update_schedule(
    state: State<'_, SchedulesState>,
    args: UpdateScheduleArgs,
) -> Result<Schedule, String> {
    let mut list = state.0.lock().unwrap();
    let entry = list
        .iter_mut()
        .find(|s| s.id == args.id)
        .ok_or_else(|| format!("schedule not found: {}", args.id))?;
    if let Some(name) = args.name {
        entry.name = name.trim().to_string();
    }
    if let Some(prompt) = args.prompt {
        entry.prompt = prompt;
    }
    if let Some(cadence) = args.cadence {
        // Cadence change → recompute next_run_ms from now.
        let now = now_ms();
        entry.next_run_ms = match &cadence {
            Cadence::Once { at_ms } => *at_ms,
            Cadence::Interval { every_seconds } => now + every_seconds * 1000,
        };
        entry.cadence = cadence;
    }
    if let Some(paused) = args.paused {
        // Resume after long pause: if next_run_ms is in the past, push
        // it forward by one cadence period so it doesn't fire immediately.
        if !paused && entry.paused {
            let now = now_ms();
            if entry.next_run_ms < now {
                if let Some(advanced) = entry.cadence.advance_after(now) {
                    entry.next_run_ms = advanced;
                }
            }
        }
        entry.paused = paused;
    }
    let updated = entry.clone();
    save_to_disk(&list).map_err(|e| e.to_string())?;
    tracing::info!(target: "deepthix::schedules", id = %updated.id, "updated");
    Ok(updated)
}

#[tauri::command]
pub fn delete_schedule(state: State<'_, SchedulesState>, id: String) -> Result<(), String> {
    let mut list = state.0.lock().unwrap();
    let before = list.len();
    list.retain(|s| s.id != id);
    if list.len() == before {
        return Err(format!("schedule not found: {id}"));
    }
    save_to_disk(&list).map_err(|e| e.to_string())?;
    tracing::info!(target: "deepthix::schedules", %id, "deleted");
    Ok(())
}

/// Force-fire a schedule right now. Useful for manual tests / "Run now"
/// button. Updates last_run_ms but does NOT recompute next_run_ms — the
/// scheduled cadence is preserved.
#[tauri::command]
pub fn run_schedule_now(
    state: State<'_, SchedulesState>,
    pty: State<'_, TerminalManager>,
    chat: State<'_, ChatManager>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let entry = {
        let list = state.0.lock().unwrap();
        list.iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| format!("schedule not found: {id}"))?
    };
    fire_schedule(&pty, &chat, &app, &entry, /*manual=*/ true);
    // Mark last_run_ms but keep next_run_ms.
    let mut list = state.0.lock().unwrap();
    if let Some(s) = list.iter_mut().find(|s| s.id == id) {
        s.last_run_ms = Some(now_ms());
    }
    save_to_disk(&list).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Scheduler thread ────────────────────────────────────────────────────

/// Spawn the background scheduler. Called once during Tauri setup.
pub fn start_scheduler(app: AppHandle) {
    let state_arc = match app.try_state::<SchedulesState>() {
        Some(s) => Arc::clone(&s.0),
        None => {
            tracing::error!(
                target: "deepthix::schedules",
                "SchedulesState missing — scheduler will not start",
            );
            return;
        }
    };
    let app_handle = app.clone();
    thread::spawn(move || {
        tracing::info!(target: "deepthix::schedules", tick_ms = SCHEDULER_TICK_MS, "scheduler started");
        loop {
            thread::sleep(Duration::from_millis(SCHEDULER_TICK_MS));
            let now = now_ms();
            let pty = match app_handle.try_state::<TerminalManager>() {
                Some(p) => p,
                None => continue,
            };
            let chat = match app_handle.try_state::<ChatManager>() {
                Some(c) => c,
                None => continue,
            };
            // Snapshot the schedules to fire under the lock, release
            // the lock, then fire (so ptyWrite + Tauri emit don't hold
            // the schedule lock).
            let to_fire: Vec<Schedule> = {
                let list = state_arc.lock().unwrap();
                list.iter()
                    .filter(|s| !s.paused && s.next_run_ms <= now)
                    .cloned()
                    .collect()
            };
            for s in to_fire {
                fire_schedule(&pty, &chat, &app_handle, &s, /*manual=*/ false);
            }
            // Update last_run_ms / next_run_ms / paused for each fired
            // job, then persist.
            let mut list = state_arc.lock().unwrap();
            let mut changed = false;
            for s in list.iter_mut() {
                if !s.paused && s.next_run_ms <= now {
                    s.last_run_ms = Some(now);
                    match s.cadence.advance_after(now) {
                        Some(next) => s.next_run_ms = next,
                        None => s.paused = true, // one-shot done
                    }
                    changed = true;
                }
            }
            if changed {
                if let Err(e) = save_to_disk(&list) {
                    tracing::warn!(target: "deepthix::schedules", error = %e, "persist failed");
                }
            }
        }
    });
}

/// Send a schedule's prompt into the target session. Looks up the
/// session_id in the ChatManager first (claude sessions live there
/// post-rewrite), then falls back to TerminalManager (shell or legacy
/// PTY claude). Best-effort: any failure becomes a warn-level
/// notification so the user knows but doesn't crash anything.
fn fire_schedule(
    pty: &TerminalManager,
    chat: &ChatManager,
    app: &AppHandle,
    s: &Schedule,
    manual: bool,
) {
    // Try chat first — it's the new home for claude sessions.
    if let Some(term_id) = chat.find_term_by_session(&s.target_session_id) {
        match chat.send_user_text(&term_id, &s.prompt) {
            Ok(_) => {
                tracing::info!(
                    target: "deepthix::schedules",
                    id = %s.id, name = %s.name, term = %term_id, manual,
                    "fired (chat)",
                );
                emit_notification(
                    app,
                    &format!("Schedule '{}' ran", s.name),
                    if manual { "Manual run" } else { &s.prompt },
                    "success",
                    &format!("schedule:{}", s.id),
                );
            }
            Err(e) => {
                tracing::warn!(target: "deepthix::schedules", id = %s.id, error = %e, "chat send failed");
                emit_notification(
                    app,
                    &format!("Schedule '{}' failed", s.name),
                    &format!("chat send: {e}"),
                    "error",
                    &format!("schedule:{}", s.id),
                );
            }
        }
        return;
    }
    let term_id = match pty.find_term_by_session(&s.target_session_id) {
        Some(tid) => tid,
        None => {
            tracing::warn!(
                target: "deepthix::schedules",
                id = %s.id, session = %s.target_session_id,
                "fire skipped — session not currently spawned",
            );
            emit_notification(
                app,
                &format!("Schedule '{}' skipped", s.name),
                &format!(
                    "Target session is not open. Open the session in project '{}' to let it run.",
                    s.target_project_id
                ),
                "warn",
                &format!("schedule:{}", s.id),
            );
            return;
        }
    };
    let payload = format!("{}\r", s.prompt);
    match pty.write(&term_id, payload.as_bytes()) {
        Ok(_) => {
            tracing::info!(
                target: "deepthix::schedules",
                id = %s.id, name = %s.name, term = %term_id, manual,
                "fired (pty)",
            );
            emit_notification(
                app,
                &format!("Schedule '{}' ran", s.name),
                if manual { "Manual run" } else { &s.prompt },
                "success",
                &format!("schedule:{}", s.id),
            );
        }
        Err(e) => {
            tracing::warn!(
                target: "deepthix::schedules",
                id = %s.id, error = %e,
                "ptyWrite failed",
            );
            emit_notification(
                app,
                &format!("Schedule '{}' failed", s.name),
                &format!("pty write: {e}"),
                "error",
                &format!("schedule:{}", s.id),
            );
        }
    }
}

fn emit_notification(app: &AppHandle, title: &str, body: &str, kind: &str, source: &str) {
    let payload = serde_json::json!({
        "title": title,
        "body": body,
        "kind": kind,
        "source": source,
        "ts_ms": now_ms(),
    });
    if let Err(e) = app.emit("deepthix-notification", payload) {
        tracing::warn!(target: "deepthix::schedules", error = %e, "notif emit failed");
    }
}
