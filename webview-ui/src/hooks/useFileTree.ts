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
      const name = basename(rootPath);
      setRoot({
        name,
        path: rootPath,
        is_dir: true,
        is_hidden: false,
        children: children.map((c) => ({ ...c, children: c.is_dir ? undefined : [] })),
      });
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
    // Mark the target as loading (immutable update along the path).
    let needsLoad = false;
    setRoot((prev) => {
      if (!prev) return prev;
      const updated = updateNode(prev, path, (node) => {
        if (!node.is_dir || node.children !== undefined) return node;
        needsLoad = true;
        return { ...node, loading: true };
      });
      return updated ?? prev;
    });
    if (!needsLoad) return;
    try {
      const children = await listDir(path);
      setRoot((prev) => {
        if (!prev) return prev;
        const updated = updateNode(prev, path, (node) => ({
          ...node,
          loading: false,
          children: children.map((c) => ({ ...c, children: c.is_dir ? undefined : [] })),
        }));
        return updated ?? prev;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][useFileTree] toggle failed', { path, msg });
      setError(msg);
      // Clear the loading flag so the user can retry.
      setRoot((prev) => {
        if (!prev) return prev;
        const updated = updateNode(prev, path, (node) => ({ ...node, loading: false }));
        return updated ?? prev;
      });
    }
  }, []);

  return { root, expanded, error, loading, toggle, refresh };
}

/**
 * Returns a new tree where the node at `path` has been replaced by `update(node)`.
 * Returns `null` if no node matches `path` (caller should keep the previous tree).
 * Pure: does not mutate the input.
 */
function updateNode(
  node: FileTreeNode,
  path: string,
  update: (n: FileTreeNode) => FileTreeNode,
): FileTreeNode | null {
  if (node.path === path) {
    return update(node);
  }
  if (!node.children) return null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const updatedChild = updateNode(child, path, update);
    if (updatedChild) {
      const newChildren = node.children.slice();
      newChildren[i] = updatedChild;
      return { ...node, children: newChildren };
    }
  }
  return null;
}

/** macOS / unix path basename. Tauri target is macOS for v1, but accept `\` defensively. */
function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}
