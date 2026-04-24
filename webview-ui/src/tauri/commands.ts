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
}

export async function saveSessions(projectId: string, sessions: PersistedSession[]): Promise<void> {
  log('saveSessions', { projectId, count: sessions.length });
  return await invoke<void>('save_sessions', { projectId, sessions });
}

export async function loadSessions(projectId: string): Promise<PersistedSession[]> {
  log('loadSessions', { projectId });
  return await invoke<PersistedSession[]>('load_sessions', { projectId });
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
