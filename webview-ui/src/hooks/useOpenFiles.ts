// Manages the list of files open in the Files pane for a given project.
// Persists the list (path-only) to ~/.deepthix/projects/<id>/open_files.json
// via the save_open_files / load_open_files Tauri commands.
//
// The hook itself doesn't load file contents — that's done lazily by
// FilesPane when a tab becomes active or visible. It just tracks "which
// paths are open and which is active".

import { useCallback, useEffect, useRef, useState } from 'react';

import { loadOpenFiles, saveOpenFiles } from '../tauri/commands';

export interface OpenFile {
  /** Absolute path to the file on disk. */
  path: string;
}

export interface UseOpenFilesResult {
  files: OpenFile[];
  activeIndex: number;
  /** Open a file (or activate it if already open). Returns the index. */
  open: (path: string) => number;
  /** Close the file at index. Adjusts activeIndex if needed. */
  close: (index: number) => void;
  /** Activate the file at index. */
  setActive: (index: number) => void;
}

/**
 * `projectId` may be null when no project is open — the hook becomes a no-op
 * (empty list, no persistence). When a project becomes active it loads the
 * persisted list. Subsequent open/close calls debounce-save it back.
 */
export function useOpenFiles(projectId: string | null): UseOpenFilesResult {
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  // Track which projectId we last loaded for, so a switch reloads cleanly.
  const lastLoadedRef = useRef<string | null>(null);
  // Debounce the persist write: many opens/closes in quick succession should
  // collapse to a single disk write.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Suppress the first persist after a load (we just loaded — no need to write
  // back the same thing).
  const justLoadedRef = useRef(false);

  // Load (or clear) when projectId changes.
  useEffect(() => {
    if (projectId === lastLoadedRef.current) return;
    lastLoadedRef.current = projectId;
    if (!projectId) {
      console.debug('[Deepthix][useOpenFiles] no projectId — clearing');
      setFiles([]);
      setActiveIndex(-1);
      return;
    }
    console.debug('[Deepthix][useOpenFiles] loading', { projectId });
    loadOpenFiles(projectId)
      .then((persisted) => {
        console.debug('[Deepthix][useOpenFiles] loaded', {
          projectId,
          count: persisted.length,
        });
        justLoadedRef.current = true;
        setFiles(persisted.map((p) => ({ path: p.path })));
        setActiveIndex(persisted.length > 0 ? 0 : -1);
      })
      .catch((e) => {
        console.error('[Deepthix][useOpenFiles] load failed', e);
        justLoadedRef.current = true;
        setFiles([]);
        setActiveIndex(-1);
      });
  }, [projectId]);

  // Persist on change. Debounced 250ms so a flurry of opens collapses.
  useEffect(() => {
    if (!projectId) return;
    if (justLoadedRef.current) {
      justLoadedRef.current = false;
      return;
    }
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      console.debug('[Deepthix][useOpenFiles] persisting', {
        projectId,
        count: files.length,
      });
      saveOpenFiles(
        projectId,
        files.map((f) => ({ path: f.path })),
      ).catch((e) => console.error('[Deepthix][useOpenFiles] save failed', e));
    }, 250);
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [files, projectId]);

  const open = useCallback((path: string): number => {
    let resultIndex = -1;
    setFiles((prev) => {
      const existing = prev.findIndex((f) => f.path === path);
      if (existing >= 0) {
        resultIndex = existing;
        return prev;
      }
      resultIndex = prev.length;
      console.debug('[Deepthix][useOpenFiles] open new', { path, index: resultIndex });
      return [...prev, { path }];
    });
    setActiveIndex(resultIndex);
    return resultIndex;
  }, []);

  const close = useCallback((index: number): void => {
    let newLen = 0;
    setFiles((prev) => {
      if (index < 0 || index >= prev.length) {
        newLen = prev.length;
        return prev;
      }
      console.debug('[Deepthix][useOpenFiles] close', { index, path: prev[index].path });
      const next = prev.slice();
      next.splice(index, 1);
      newLen = next.length;
      return next;
    });
    setActiveIndex((prev) => {
      if (newLen <= 0) return -1;
      if (prev < 0) return -1;
      // Closed a tab to the left of (or at) the active one → shift left and clamp.
      if (index < prev) return prev - 1;
      if (index === prev) return Math.min(prev, newLen - 1);
      // Closed a tab to the right → active position unchanged.
      return prev;
    });
  }, []);

  const setActive = useCallback((index: number): void => {
    setActiveIndex(index);
  }, []);

  return { files, activeIndex, open, close, setActive };
}
