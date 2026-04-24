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

export async function listDir(path: string): Promise<FileEntry[]> {
  log('listDir', { path });
  return await invoke<FileEntry[]>('list_dir', { path });
}
