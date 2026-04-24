import { useCallback, useEffect, useState } from 'react';

import {
  addProject as cmdAddProject,
  listProjects as cmdListProjects,
  openFolder as cmdOpenFolder,
  removeProject as cmdRemoveProject,
  switchProject as cmdSwitchProject,
} from '../tauri/commands';
import { onProjectSwitched } from '../tauri/events';
import type { Project } from '../tauri/types';

export interface UseProjectsResult {
  projects: Project[];
  activeProjectId: string | null;
  activeProject: Project | null;
  loading: boolean;
  error: string | null;
  /** Opens the folder picker; if a folder is chosen, adds it as a project and activates it. */
  openAndAddProject: () => Promise<Project | null>;
  switchProject: (id: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const file = await cmdListProjects();
      setProjects(file.projects);
      setActiveProjectId(file.active_project_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useProjects] refresh failed', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sync active id from the Tauri-side event (covers cases where switch is
  // initiated from elsewhere — for Phase 1 only via switchProject below, but
  // future phases may switch from menus, hotkeys, etc.).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onProjectSwitched((id) => {
      setActiveProjectId(id);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const openAndAddProject = useCallback(async (): Promise<Project | null> => {
    setError(null);
    try {
      const path = await cmdOpenFolder();
      if (!path) return null;
      const project = await cmdAddProject(path);
      await refresh();
      return project;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useProjects] openAndAddProject failed', msg);
      setError(msg);
      return null;
    }
  }, [refresh]);

  const switchProject = useCallback(async (id: string): Promise<void> => {
    setError(null);
    try {
      await cmdSwitchProject(id);
      // The project_switched event handler will update activeProjectId.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useProjects] switchProject failed', msg);
      setError(msg);
    }
  }, []);

  const removeProject = useCallback(async (id: string): Promise<void> => {
    setError(null);
    try {
      await cmdRemoveProject(id);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useProjects] removeProject failed', msg);
      setError(msg);
    }
  }, [refresh]);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  return {
    projects,
    activeProjectId,
    activeProject,
    loading,
    error,
    openAndAddProject,
    switchProject,
    removeProject,
    refresh,
  };
}
