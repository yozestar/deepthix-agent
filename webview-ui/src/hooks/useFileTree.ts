import { useCallback, useEffect, useState } from 'react';

import { listDir } from '../tauri/commands';
import type { FileEntry } from '../tauri/types';

export interface FileTreeNode extends FileEntry {
  children?: FileTreeNode[];
  loading?: boolean;
}

export interface UseFileTreeResult {
  root: FileTreeNode | null;
  expanded: Set<string>;
  error: string | null;
  loading: boolean;
  toggle: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useFileTree(rootPath: string | null): UseFileTreeResult {
  const [root, setRoot] = useState<FileTreeNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!rootPath) {
      setRoot(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const children = await listDir(rootPath);
      const name = rootPath.split('/').filter(Boolean).pop() ?? rootPath;
      setRoot({
        name,
        path: rootPath,
        is_dir: true,
        is_hidden: false,
        children: children.map((c) => ({ ...c, children: c.is_dir ? undefined : [] })),
      });
      // Reset expansion to top level on refresh.
      setExpanded(new Set([rootPath]));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useFileTree] refresh failed', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async (path: string): Promise<void> => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    // Lazy-load children if needed.
    setRoot((prev) => {
      if (!prev) return prev;
      const target = findNode(prev, path);
      if (!target || !target.is_dir || target.children !== undefined) return prev;
      // Mark loading; actual fetch happens below.
      target.loading = true;
      return { ...prev };
    });
    try {
      const children = await listDir(path);
      setRoot((prev) => {
        if (!prev) return prev;
        const target = findNode(prev, path);
        if (target) {
          target.children = children.map((c) => ({ ...c, children: c.is_dir ? undefined : [] }));
          target.loading = false;
        }
        return { ...prev };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useFileTree] toggle failed', { path, msg });
      setError(msg);
    }
  }, []);

  return { root, expanded, error, loading, toggle, refresh };
}

function findNode(node: FileTreeNode, path: string): FileTreeNode | null {
  if (node.path === path) return node;
  if (!node.children) return null;
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}
