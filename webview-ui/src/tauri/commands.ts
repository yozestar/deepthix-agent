import { invoke } from '@tauri-apps/api/core';

import type { FileEntry, Project, ProjectsFile, SwitchResult } from './types';

function log(name: string, args?: unknown): void {
  console.debug('[Deepthix][cmd]', name, args ?? '');
}

export async function openFolder(): Promise<string | null> {
  log('openFolder');
  return await invoke<string | null>('open_folder');
}

export async function addProject(path: string): Promise<Project> {
  log('addProject', { path });
  return await invoke<Project>('add_project', { path });
}

export async function listProjects(): Promise<ProjectsFile> {
  log('listProjects');
  return await invoke<ProjectsFile>('list_projects');
}

export async function switchProject(id: string): Promise<SwitchResult> {
  log('switchProject', { id });
  return await invoke<SwitchResult>('switch_project', { id });
}

export async function removeProject(id: string): Promise<boolean> {
  log('removeProject', { id });
  return await invoke<boolean>('remove_project', { id });
}

export async function renameProject(id: string, name: string): Promise<boolean> {
  log('renameProject', { id, name });
  return await invoke<boolean>('rename_project', { id, name });
}

export async function listDir(path: string): Promise<FileEntry[]> {
  log('listDir', { path });
  return await invoke<FileEntry[]>('list_dir', { path });
}

export async function saveLayout(projectId: string, layout: unknown): Promise<void> {
  log('saveLayout', { projectId });
  return await invoke<void>('save_layout', { projectId, layout });
}

export async function loadLayout(projectId: string): Promise<unknown | null> {
  log('loadLayout', { projectId });
  return await invoke<unknown | null>('load_layout', { projectId });
}

export type TerminalKind = 'shell' | 'claude';

export interface SpawnTerminalResult {
  id: string;
  session_id: string | null;
}

export async function spawnTerminal(
  cwd: string,
  kind: TerminalKind = 'shell',
  cols?: number,
  rows?: number,
  opts?: { skipPermissions?: boolean; resumeSessionId?: string },
): Promise<SpawnTerminalResult> {
  log('spawnTerminal', { cwd, kind, cols, rows, opts });
  return await invoke<SpawnTerminalResult>('spawn_terminal', {
    cwd,
    cols,
    rows,
    kind,
    skipPermissions: opts?.skipPermissions ?? false,
    resumeSessionId: opts?.resumeSessionId ?? null,
  });
}

export interface PersistedSession {
  session_id: string;
  label: string;
  cwd: string;
  skip_permissions: boolean;
  created_at_ms: number;
  /** Per-session terminal font size (px). Optional for backward compat. */
  font_size?: number | null;
  /** Per-session terminal font family CSS string. Optional for backward compat. */
  font_family?: string | null;
  /** Per-session terminal line-height multiplier (1.0–1.6). Optional. */
  line_height?: number | null;
  /** Free-form per-session notes shown on the Overview card. Optional. */
  notes?: string | null;
}

export async function saveSessions(projectId: string, sessions: PersistedSession[]): Promise<void> {
  log('saveSessions', { projectId, count: sessions.length });
  return await invoke<void>('save_sessions', { projectId, sessions });
}

export async function loadSessions(projectId: string): Promise<PersistedSession[]> {
  log('loadSessions', { projectId });
  return await invoke<PersistedSession[]>('load_sessions', { projectId });
}

/** Persist the xterm-serialized scrollback for `sessionId` to disk. */
export async function saveTerminalScrollback(
  projectId: string,
  sessionId: string,
  content: string,
): Promise<void> {
  log('saveTerminalScrollback', { projectId, sessionId, bytes: content.length });
  return await invoke<void>('save_terminal_scrollback', { projectId, sessionId, content });
}

/** Load previously-saved scrollback for `sessionId`. Returns null if none exists. */
export async function loadTerminalScrollback(
  projectId: string,
  sessionId: string,
): Promise<string | null> {
  log('loadTerminalScrollback', { projectId, sessionId });
  return await invoke<string | null>('load_terminal_scrollback', { projectId, sessionId });
}

/** Best-effort delete of the saved scrollback (called when a session is closed). */
export async function clearTerminalScrollback(
  projectId: string,
  sessionId: string,
): Promise<void> {
  log('clearTerminalScrollback', { projectId, sessionId });
  return await invoke<void>('clear_terminal_scrollback', { projectId, sessionId });
}

export interface JsonlStat {
  /** File size in bytes. 0 if missing. */
  size_bytes: number;
  /** Last-modified epoch ms. 0 if missing. */
  mtime_ms: number;
}

/**
 * Size + mtime of the claude JSONL transcript for a session. The
 * frontend polls this as a reliable "is claude actively working?"
 * signal — checking SIZE growth (not just mtime) avoids false working
 * flashes from heartbeat/touch operations that don't add real data.
 */
export async function jsonlMtimeMs(
  projectCwd: string,
  sessionId: string,
): Promise<JsonlStat> {
  return await invoke<JsonlStat>('jsonl_mtime_ms', { projectCwd, sessionId });
}

/** Absolute path to the per-session dashboard HTML file (used in placeholder). */
export async function dashboardPath(projectId: string, sessionId: string): Promise<string> {
  log('dashboardPath', { projectId, sessionId });
  return await invoke<string>('dashboard_path', { projectId, sessionId });
}

/** Read the per-session dashboard HTML; returns null if the file doesn't exist yet. */
export async function readSessionDashboard(
  projectId: string,
  sessionId: string,
): Promise<string | null> {
  // Intentionally not logging — we poll this every few seconds and the noise
  // would drown out everything else in the console.
  return await invoke<string | null>('read_session_dashboard', { projectId, sessionId });
}

/** Write the per-session dashboard HTML (atomic via .tmp + rename). */
export async function writeSessionDashboard(
  projectId: string,
  sessionId: string,
  html: string,
): Promise<void> {
  log('writeSessionDashboard', { projectId, sessionId, bytes: html.length });
  return await invoke<void>('write_session_dashboard', { projectId, sessionId, html });
}

/** mtime of the dashboard file in epoch ms (0 if missing). Cheap polling probe. */
export async function dashboardMtimeMs(
  projectId: string,
  sessionId: string,
): Promise<number> {
  return await invoke<number>('dashboard_mtime_ms', { projectId, sessionId });
}

export interface ProcessInfo {
  pid: number;
  command: string;
  cwd: string | null;
}

export async function listProcesses(projectPath: string): Promise<ProcessInfo[]> {
  log('listProcesses', { projectPath });
  return await invoke<ProcessInfo[]>('list_processes', { projectPath });
}

export async function killProcess(pid: number): Promise<void> {
  log('killProcess', { pid });
  return await invoke<void>('kill_process', { pid });
}

/**
 * Spawn the user's real Google Chrome on `url` at the given viewport size.
 * Returns a friendly error string if Chrome isn't installed (or `open` fails).
 */
export async function openChrome(url: string, width: number, height: number): Promise<void> {
  log('openChrome', { url, width, height });
  return await invoke<void>('open_chrome', { url, width, height });
}

/**
 * Hand a URL off to the OS default browser via macOS `open`. Used by the
 * xterm web-links addon — clicking a link inside a terminal opens it in
 * the user's normal browser, not the Tauri webview. Refuses non-http(s).
 */
export async function openExternalUrl(url: string): Promise<void> {
  log('openExternalUrl', { url });
  return await invoke<void>('open_external_url', { url });
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ClaudeUsage {
  /** All-time totals keyed by model name (e.g. "claude-opus-4-7"). */
  all_time: Record<string, ModelUsage>;
  /** Today (local timezone) totals keyed by model name. Subset of all_time. */
  today: Record<string, ModelUsage>;
  /** Number of JSONL files scanned. */
  session_count: number;
}

/**
 * Aggregate claude code token usage from all on-disk JSONL transcripts in
 * `~/.claude/projects/`. Polled by the UsagePane.
 */
export async function readClaudeUsage(): Promise<ClaudeUsage> {
  log('readClaudeUsage');
  return await invoke<ClaudeUsage>('read_claude_usage');
}

export interface ClaudeSubscription {
  /** "max", "pro", "free", … or empty if not signed in. */
  subscription_type: string;
  /** "default_claude_max_20x" etc. Empty if absent. */
  rate_limit_tier: string;
  /** True iff the keychain entry was readable. */
  authenticated: boolean;
}

/** Subscription tier read from the macOS keychain (Claude Code-credentials). */
export async function readClaudeSubscription(): Promise<ClaudeSubscription> {
  log('readClaudeSubscription');
  return await invoke<ClaudeSubscription>('read_claude_subscription');
}

export interface DailyActivity {
  date: string;
  message_count: number;
  session_count: number;
  tool_call_count: number;
}

export interface ClaudeActivity {
  today: DailyActivity;
  all_time: DailyActivity;
  last_computed_date: string;
}

/** Daily message/session/tool counts from claude's local stats-cache.json. */
export async function readClaudeDailyActivity(): Promise<ClaudeActivity> {
  log('readClaudeDailyActivity');
  return await invoke<ClaudeActivity>('read_claude_daily_activity');
}

export interface UsageBucket {
  /** 0.0–1.0 fraction consumed. */
  utilization: number;
  /** ISO-8601 UTC timestamp when this window resets. */
  resets_at: string;
}

export interface ClaudeUsageLimits {
  /** Current 5h session window. */
  five_hour: UsageBucket;
  /** Weekly all-models bucket. */
  seven_day: UsageBucket;
  /** Weekly Sonnet-only bucket. */
  seven_day_sonnet: UsageBucket;
  /** Set when the API call failed (4xx/5xx, network, no token). */
  error?: string | null;
}

/**
 * Live subscription utilization fetched from the same endpoint
 * claude.ai itself uses (`/api/oauth/usage`). Mirrors the "Plan usage
 * limits" panel — current session %, weekly %, sonnet-only %.
 */
export async function readClaudeUsageLimits(): Promise<ClaudeUsageLimits> {
  log('readClaudeUsageLimits');
  return await invoke<ClaudeUsageLimits>('read_claude_usage_limits');
}

export interface UsageSnapshot {
  /** Raw JSON the statusline-dumper script captured (string). Empty if none. */
  body: string;
  /** mtime of the snapshot file in epoch ms; 0 if absent. */
  mtime_ms: number;
}

/**
 * Read the most recent statusline-dumper snapshot. Claude pipes a JSON
 * containing { rate_limits, cost, context_window, model, ... } to its
 * statusLine command — we install a script that captures it. As long
 * as at least one Deepthix-spawned claude session is running, this
 * returns the freshest live usage data with NO OAuth, NO Cloudflare,
 * NO rate limits.
 */
export async function readClaudeUsageSnapshot(): Promise<UsageSnapshot> {
  return await invoke<UsageSnapshot>('read_claude_usage_snapshot');
}

export type SkillScope = 'global' | 'project' | 'plugin';

export interface SkillInfo {
  scope: SkillScope;
  name: string;
  description: string;
  /** Absolute path to SKILL.md. */
  path: string;
  /** True if `disable-model-invocation: true` is set. */
  disabled: boolean;
  /** True if `user-invocable: false` is set (hidden from /menu). */
  hidden_from_menu: boolean;
  /** Plugin namespace (e.g. "superpowers") for plugin-scope skills. */
  plugin: string | null;
}

/** Discover all claude code skills (global + project + plugins). */
export async function listSkills(projectPath: string | null): Promise<SkillInfo[]> {
  log('listSkills', { projectPath });
  return await invoke<SkillInfo[]>('list_skills', { projectPath });
}

/** Toggle `disable-model-invocation` in a SKILL.md frontmatter. Refuses on plugin paths. */
export async function setSkillEnabled(path: string, enabled: boolean): Promise<void> {
  log('setSkillEnabled', { path, enabled });
  return await invoke<void>('set_skill_enabled', { path, enabled });
}

export interface TranscribeResult {
  text: string;
  elapsed_ms: number;
}

/**
 * Transcribe a base64-encoded audio blob via local whisper.cpp. The
 * frontend captures via MediaRecorder (WebM/Opus by default) and we
 * pipeline it through ffmpeg → whisper-cli on the Rust side.
 */
export async function transcribeAudio(
  audioBase64: string,
  mime: string | null,
  lang: string | null,
): Promise<TranscribeResult> {
  log('transcribeAudio', { mime, lang, bytes: audioBase64.length });
  return await invoke<TranscribeResult>('transcribe_audio', {
    audioBase64,
    mime,
    lang,
  });
}

export type NotifKind = 'info' | 'success' | 'warn' | 'error';

export interface NotificationRecord {
  title: string;
  body: string;
  kind: NotifKind;
  source: string;
  ts_ms: number;
}

/** Publish a notification (in-app toast + macOS banner). Source defaults
 *  to "webview" when omitted. */
export async function notifyUser(args: {
  title: string;
  body?: string;
  kind?: NotifKind;
  source?: string;
}): Promise<void> {
  log('notify_user', { title: args.title, kind: args.kind ?? 'info' });
  return await invoke<void>('notify_user', {
    title: args.title,
    body: args.body ?? null,
    kind: args.kind ?? null,
    source: args.source ?? null,
  });
}

/** Pull recent notifications from disk on app startup. */
export async function listRecentNotifications(
  limit = 20,
): Promise<NotificationRecord[]> {
  return await invoke<NotificationRecord[]>('list_recent_notifications', { limit });
}

// ─── Chat (stream-json claude) ──────────────────────────────────────────

export interface ChatSpawnArgs {
  cwd: string;
  resume_session_id?: string | null;
  skip_permissions?: boolean;
  model?: string | null;
}

export interface ChatSpawnResult {
  term_id: string;
  session_id: string | null;
}

export async function chatSpawn(args: ChatSpawnArgs): Promise<ChatSpawnResult> {
  log('chat_spawn', { cwd: args.cwd, resume: args.resume_session_id ?? null });
  return await invoke<ChatSpawnResult>('chat_spawn', { args });
}

export async function chatSendUserText(termId: string, text: string): Promise<void> {
  log('chat_send_user_text', { termId, chars: text.length });
  return await invoke<void>('chat_send_user_text', { termId, text });
}

export async function chatKill(termId: string): Promise<void> {
  log('chat_kill', { termId });
  return await invoke<void>('chat_kill', { termId });
}

/** Send SIGINT to the underlying claude process so it stops the
 *  current turn (preserves conversation state on disk; the JSONL is
 *  already flushed). The child usually exits — caller can re-spawn
 *  with --resume to keep going. */
export async function chatInterrupt(termId: string): Promise<void> {
  log('chat_interrupt', { termId });
  return await invoke<void>('chat_interrupt', { termId });
}

export async function chatSetSessionId(termId: string, sessionId: string): Promise<void> {
  return await invoke<void>('chat_set_session_id', { termId, sessionId });
}

export async function chatLoadHistory(projectCwd: string, sessionId: string): Promise<string[]> {
  return await invoke<string[]>('chat_load_history', { projectCwd, sessionId });
}

/** Read a human-readable excerpt of a past session — last `lastN`
 *  user/assistant turns, formatted for handing to a Coach session. */
export async function readSessionExcerpt(
  projectCwd: string,
  sessionId: string,
  lastN = 20,
): Promise<string> {
  return await invoke<string>('read_session_excerpt', { projectCwd, sessionId, lastN });
}

/** Append a coach-suggested note to the project's CLAUDE.md so the
 *  insight persists into the main session's context. */
export async function appendToClaudeMd(projectCwd: string, text: string): Promise<void> {
  return await invoke<void>('append_to_claude_md', { projectCwd, text });
}

// ─── Schedules ──────────────────────────────────────────────────────────

export type Cadence =
  | { kind: 'once'; at_ms: number }
  | { kind: 'interval'; every_seconds: number };

export interface Schedule {
  id: string;
  name: string;
  target_session_id: string;
  target_project_id: string;
  prompt: string;
  cadence: Cadence;
  paused: boolean;
  last_run_ms: number | null;
  next_run_ms: number;
  created_ms: number;
}

export async function listSchedules(): Promise<Schedule[]> {
  return await invoke<Schedule[]>('list_schedules');
}

export async function createSchedule(args: {
  name: string;
  target_session_id: string;
  target_project_id: string;
  prompt: string;
  cadence: Cadence;
}): Promise<Schedule> {
  return await invoke<Schedule>('create_schedule', { args });
}

export async function updateSchedule(args: {
  id: string;
  name?: string;
  prompt?: string;
  cadence?: Cadence;
  paused?: boolean;
}): Promise<Schedule> {
  return await invoke<Schedule>('update_schedule', { args });
}

export async function deleteSchedule(id: string): Promise<void> {
  return await invoke<void>('delete_schedule', { id });
}

export async function runScheduleNow(id: string): Promise<void> {
  return await invoke<void>('run_schedule_now', { id });
}

/** Snapshot a file the user dragged onto the window into
 *  ~/.deepthix/dropped/ and return the stable absolute path. Used to
 *  defeat macOS's transient TemporaryItems/NSIRD_screencaptureui_*
 *  paths that vanish the moment the drag finishes. */
export async function stashDroppedFile(src: string): Promise<string> {
  return await invoke<string>('stash_dropped_file', { src });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  return await invoke<void>('pty_write', { id, data });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return await invoke<void>('pty_resize', { id, cols, rows });
}

export async function killTerminal(id: string): Promise<void> {
  log('killTerminal', { id });
  return await invoke<void>('kill_terminal', { id });
}

export async function readProjectMemory(projectPath: string): Promise<string> {
  log('readProjectMemory', { projectPath });
  return await invoke<string>('read_project_memory', { projectPath });
}

export async function writeProjectMemory(projectPath: string, content: string): Promise<void> {
  log('writeProjectMemory', { projectPath, bytes: content.length });
  return await invoke<void>('write_project_memory', { projectPath, content });
}

export async function readGlobalMemory(): Promise<string> {
  log('readGlobalMemory');
  return await invoke<string>('read_global_memory');
}

export async function writeGlobalMemory(content: string): Promise<void> {
  log('writeGlobalMemory', { bytes: content.length });
  return await invoke<void>('write_global_memory', { content });
}

// ─── Global config (Phase 11) ─────────────────────────────────────────────

/**
 * Mirror of Rust `commands::config::GlobalConfig`. All fields are optional —
 * the frontend supplies defaults from `webview-ui/src/constants.ts` when
 * a value is missing. Replaces the per-session font/zoom fields previously
 * carried in `PersistedSession`.
 */
export interface GlobalConfigPayload {
  terminal_font_size?: number | null;
  terminal_font_family?: string | null;
  terminal_line_height?: number | null;
  theme_id?: string | null;
}

export async function readGlobalConfig(): Promise<GlobalConfigPayload> {
  log('readGlobalConfig');
  return await invoke<GlobalConfigPayload>('read_global_config');
}

export async function writeGlobalConfig(config: GlobalConfigPayload): Promise<void> {
  log('writeGlobalConfig', config);
  return await invoke<void>('write_global_config', { config });
}

// ─── Files pane (Phase 6) ─────────────────────────────────────────────────

/** Read a UTF-8 text file. Caller should have validated kind+size first. */
export async function readFile(path: string): Promise<string> {
  log('readFile', { path });
  return await invoke<string>('read_file', { path });
}

/** Overwrite a text file with `content`. */
export async function writeFile(path: string, content: string): Promise<void> {
  log('writeFile', { path, bytes: content.length });
  return await invoke<void>('write_file', { path, content });
}

export type FileKind = 'text' | 'image' | 'video' | 'pdf' | 'unknown';

/** Classify a file by extension so the UI knows how to render it. */
export async function fileKind(path: string): Promise<FileKind> {
  log('fileKind', { path });
  return await invoke<FileKind>('file_kind', { path });
}

/** Returns the file size in bytes, used for the "large file" warning gate. */
export async function fileSize(path: string): Promise<number> {
  log('fileSize', { path });
  return await invoke<number>('file_size', { path });
}

export interface FileBytes {
  b64: string;
  mime: string;
}

/** Read a binary file and return base64 + MIME for direct rendering. */
export async function readFileBytesBase64(path: string): Promise<FileBytes> {
  log('readFileBytesBase64', { path });
  const [b64, mime] = await invoke<[string, string]>('read_file_bytes_base64', { path });
  return { b64, mime };
}

export interface PersistedOpenFile {
  path: string;
}

export async function saveOpenFiles(
  projectId: string,
  files: PersistedOpenFile[],
): Promise<void> {
  log('saveOpenFiles', { projectId, count: files.length });
  return await invoke<void>('save_open_files', { projectId, files });
}

export async function loadOpenFiles(projectId: string): Promise<PersistedOpenFile[]> {
  log('loadOpenFiles', { projectId });
  return await invoke<PersistedOpenFile[]>('load_open_files', { projectId });
}
