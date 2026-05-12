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
  /** Every bucket the server returned, keyed by raw field name.
   *  Lets the UI render new buckets (e.g., "claude_design_weekly")
   *  without a Rust-side schema bump. */
  all_buckets?: Record<string, UsageBucket>;
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

/** Read raw SKILL.md content for the viewer modal. */
export async function readSkillFile(path: string): Promise<string> {
  log('readSkillFile', { path });
  return await invoke<string>('read_skill_file', { path });
}

/** Install a skill from raw markdown text (used by marketplace fetch). */
export async function installSkillFromText(args: {
  name: string;
  content: string;
  scope: 'global' | 'project';
  projectPath: string | null;
  overwrite?: boolean;
}): Promise<string> {
  log('installSkillFromText', { name: args.name, scope: args.scope });
  return await invoke<string>('install_skill_from_text', args);
}

/** Install a skill from a local file or directory (used by drag-drop). */
export async function installSkillFromPath(args: {
  sourcePath: string;
  scope: 'global' | 'project';
  projectPath: string | null;
  overwrite?: boolean;
}): Promise<string> {
  log('installSkillFromPath', { source: args.sourcePath, scope: args.scope });
  return await invoke<string>('install_skill_from_path', args);
}

/** Delete a skill (removes the whole containing directory). */
export async function deleteSkill(path: string): Promise<void> {
  log('deleteSkill', { path });
  return await invoke<void>('delete_skill', { path });
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
  /** Reasoning effort level — `low | medium | high | xhigh | max`.
   *  null lets claude pick its default. */
  effort?: string | null;
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

/**
 * Like chatSendUserText but ALSO attaches files. Image extensions get
 * read + base64-encoded server-side and sent as proper image content
 * blocks. Non-image paths are appended to the text portion as plain
 * references so claude can choose to Read them.
 */
export async function chatSendUserWithAttachments(
  termId: string,
  text: string,
  paths: string[],
): Promise<void> {
  log('chat_send_user_with_attachments', { termId, chars: text.length, paths: paths.length });
  return await invoke<void>('chat_send_user_with_attachments', { termId, text, paths });
}

export async function chatKill(termId: string): Promise<void> {
  log('chat_kill', { termId });
  return await invoke<void>('chat_kill', { termId });
}

/** Reply to a tool_use the assistant emitted (typically AskUserQuestion).
 *  Without this, claude hangs on the tool call until it self-cancels. */
export async function chatSendToolResult(
  termId: string,
  toolUseId: string,
  content: string,
): Promise<void> {
  log('chat_send_tool_result', { termId, toolUseId, chars: content.length });
  return await invoke<void>('chat_send_tool_result', { termId, toolUseId, content });
}

/** Send SIGINT to the underlying claude process so it stops the
 *  current turn (preserves conversation state on disk; the JSONL is
 *  already flushed). The child usually exits — caller can re-spawn
 *  with --resume to keep going. */
export async function chatInterrupt(termId: string): Promise<void> {
  log('chat_interrupt', { termId });
  return await invoke<void>('chat_interrupt', { termId });
}

/** Stop the current turn AND immediately respawn under the same term_id
 *  with --resume so the user can keep talking to the same conversation
 *  without recreating the session. Pass the current model so the
 *  respawn doesn't downgrade. */
export async function chatInterruptAndResume(
  termId: string,
  model: string | null,
): Promise<void> {
  log('chat_interrupt_and_resume', { termId, model });
  return await invoke<void>('chat_interrupt_and_resume', { termId, model });
}

/** Soft-restart a chat session under a different model. Same term_id,
 *  same session_id (--resume), new --model + optional --effort. The
 *  webview's existing event subscription keeps working.
 *
 *  effort semantics: undefined → preserve existing effort. null → clear
 *  (let claude pick the default). string → use that level
 *  (low | medium | high | xhigh | max). */
export async function chatSwitchModel(
  termId: string,
  model: string,
  effort?: string | null,
): Promise<void> {
  log('chat_switch_model', { termId, model, effort });
  return await invoke<void>('chat_switch_model', { termId, model, effort });
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

export interface CoachState {
  enabled: boolean;
  coach_session_id: string | null;
  last_run_ms: number;
}

export async function readProjectCoachState(projectId: string): Promise<CoachState> {
  return await invoke<CoachState>('read_project_coach_state', { projectId });
}

export async function writeProjectCoachState(
  projectId: string,
  state: CoachState,
): Promise<void> {
  return await invoke<void>('write_project_coach_state', { projectId, state });
}

/** Read the persisted coach message log (raw JSON string, "" if file
 *  doesn't exist yet). The shape is whatever the FE serializes. */
export async function readProjectCoachMessages(projectId: string): Promise<string> {
  return await invoke<string>('read_project_coach_messages', { projectId });
}

export async function writeProjectCoachMessages(
  projectId: string,
  body: string,
): Promise<void> {
  return await invoke<void>('write_project_coach_messages', { projectId, body });
}

/** Global (cross-project) coach state — single ON/OFF toggle for the
 *  whole app. Replaces the per-project state for the new "one coach
 *  watches every project's sessions" model. */
export async function readGlobalCoachState(): Promise<CoachState> {
  return await invoke<CoachState>('read_global_coach_state');
}

export async function writeGlobalCoachState(state: CoachState): Promise<void> {
  return await invoke<void>('write_global_coach_state', { state });
}

export async function readGlobalCoachMessages(): Promise<string> {
  return await invoke<string>('read_global_coach_messages');
}

export async function writeGlobalCoachMessages(body: string): Promise<void> {
  return await invoke<void>('write_global_coach_messages', { body });
}

/** Path to the dedicated coach workspace under ~/.deepthix/coach-workspace.
 *  Created on demand. The global coach session is spawned with this as
 *  its cwd so it stays alive across project switches. */
export async function coachWorkspacePath(): Promise<string> {
  return await invoke<string>('coach_workspace_path');
}

// ─── Workflows ──────────────────────────────────────────────────────────
// Named claude prompt recipes the user (or claude itself) can save and
// re-fire on demand. Storage lives at ~/.deepthix/workflows.json + per-
// workflow runs at ~/.deepthix/workflows/<id>/runs.jsonl.

export interface Workflow {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tags: string[];
  created_ms: number;
  updated_ms: number;
}

export interface WorkflowRun {
  run_id: string;
  workflow_id: string;
  started_ms: number;
  ended_ms?: number | null;
  target_session_id?: string | null;
  target_project_id?: string | null;
  prompt: string;
  /** "running" | "ok" | "error" | "interrupted" */
  status: string;
}

/** Path to ~/.deepthix/workflows.json. Exposed so claude sessions can
 *  Read/Edit/Write it directly to discover or modify workflows. */
export async function workflowsPath(): Promise<string> {
  return await invoke<string>('workflows_path');
}

export async function listWorkflows(): Promise<Workflow[]> {
  return await invoke<Workflow[]>('list_workflows');
}

export async function createWorkflow(args: {
  name: string;
  description: string;
  prompt: string;
  tags: string[];
}): Promise<Workflow> {
  log('createWorkflow', { name: args.name });
  return await invoke<Workflow>('create_workflow', args);
}

export async function updateWorkflow(args: {
  id: string;
  name?: string;
  description?: string;
  prompt?: string;
  tags?: string[];
}): Promise<Workflow> {
  return await invoke<Workflow>('update_workflow', args);
}

export async function deleteWorkflow(id: string): Promise<void> {
  log('deleteWorkflow', { id });
  return await invoke<void>('delete_workflow', { id });
}

export async function listWorkflowRuns(workflowId: string): Promise<WorkflowRun[]> {
  return await invoke<WorkflowRun[]>('list_workflow_runs', { workflowId });
}

export async function appendWorkflowRun(run: WorkflowRun): Promise<void> {
  return await invoke<void>('append_workflow_run', { run });
}

// ─── Resume / rewind ────────────────────────────────────────────────────

export interface ResumableSession {
  session_id: string;
  jsonl_path: string;
  modified_ms: number;
  size_bytes: number;
  first_user_text: string;
  user_turn_count: number;
}

/** List every resumable claude session for this project cwd, newest
 *  first. Backs the /resume picker. */
export async function listResumableSessions(projectCwd: string): Promise<ResumableSession[]> {
  return await invoke<ResumableSession[]>('list_resumable_sessions', { projectCwd });
}

/** Truncate the active session's JSONL by removing the last N user
 *  turns. After this call, claude --resume on the same session_id
 *  picks up from before those turns. Returns the new line count. */
export async function rewindSession(
  projectCwd: string,
  sessionId: string,
  n: number,
): Promise<number> {
  log('rewindSession', { sessionId, n });
  return await invoke<number>('rewind_session', { projectCwd, sessionId, n });
}

/** Switch the bound term_id to a DIFFERENT session (used by /resume).
 *  Kills the current claude child + respawns with --resume on the
 *  picked session_id. Model and effort are preserved from the prior
 *  spawn unless `model` is provided. */
export async function chatResumeOtherSession(
  termId: string,
  sessionId: string,
  model: string | null,
): Promise<void> {
  log('chatResumeOtherSession', { termId, sessionId });
  return await invoke<void>('chat_resume_other_session', { termId, sessionId, model });
}

// ─── Variables ──────────────────────────────────────────────────────────
// Shared key/value scratchpad. Both the user (VARIABLES tab) and
// claude (Read/Write on the JSON catalog) can read + write.

export interface Variable {
  key: string;
  value: string;
  description: string;
  created_ms: number;
  updated_ms: number;
}

/** Path to ~/.deepthix/variables.json (also exposed to claude as
 *  $DEEPTHIX_VARIABLES_PATH so it can Read/Write the file directly). */
export async function variablesPath(): Promise<string> {
  return await invoke<string>('variables_path');
}

export async function listVariables(): Promise<Variable[]> {
  return await invoke<Variable[]>('list_variables');
}

export async function setVariable(args: {
  key: string;
  value: string;
  description?: string;
}): Promise<Variable> {
  log('setVariable', { key: args.key });
  return await invoke<Variable>('set_variable', args);
}

export async function deleteVariable(key: string): Promise<void> {
  log('deleteVariable', { key });
  return await invoke<void>('delete_variable', { key });
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

/** Write a chunk of pasted text to ~/.deepthix/dropped/paste_*.txt and
 *  return the path so the chat composer can attach it like any dragged
 *  file. Used when the user pastes a wall of text (logs, code, etc) —
 *  keeping it out of the prompt body lets claude Read() it rather than
 *  choke on a giant inline blob. */
export async function stashPasteAsAttachment(content: string): Promise<string> {
  return await invoke<string>('stash_paste_as_attachment', { content });
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
  box_style?: string | null;
  /** Hard cap on concurrent claude chat sessions (range 2..20, default 6). */
  max_active_sessions?: number | null;
  /** Trailing messages kept in webview state per session (50..500, default 100). */
  max_messages_per_session?: number | null;
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
