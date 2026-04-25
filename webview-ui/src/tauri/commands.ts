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
