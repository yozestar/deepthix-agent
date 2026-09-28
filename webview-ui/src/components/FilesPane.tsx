// FilesPane — the right-pane content for the Files mode tab.
//
// Layout:
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ search input                                                    │
//   │ ┌──────────────┬────────────────────────────────────────────┐  │
//   │ │ FILE TREE    │ tab strip (file1.ts ✕  file2.png ✕  ...)   │  │
//   │ │              ├────────────────────────────────────────────┤  │
//   │ │              │                                            │  │
//   │ │              │   active file content                      │  │
//   │ │              │   (textarea / image / pdf / unknown)       │  │
//   │ │              │                                            │  │
//   │ └──────────────┴────────────────────────────────────────────┘  │
//   └─────────────────────────────────────────────────────────────────┘
//
// Click a file in the tree (or in the sidebar tree) → opens as a sub-tab on
// the right. Edit text files and Cmd+S (or Save button) to write back. Open
// files persist per-project across reboots.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { UseFileTreeResult } from '../hooks/useFileTree';
import type { UseOpenFilesResult } from '../hooks/useOpenFiles';
import {
  type FileBytes,
  type FileKind,
  fileKind as cmdFileKind,
  fileSize as cmdFileSize,
  readFile as cmdReadFile,
  readFileBytesBase64 as cmdReadFileBytes,
  writeFile as cmdWriteFile,
} from '../tauri/commands';
import { CodeEditor } from './CodeEditor';
import { FileTree } from './FileTree';
import { PdfViewer } from './PdfViewer';

interface Props {
  projectPath: string | null;
  fileTree: UseFileTreeResult;
  openFiles: UseOpenFilesResult;
}

const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 600;
const SIDEBAR_STORAGE_KEY = 'deepthix.filesPaneSidebarWidth';
const LARGE_FILE_THRESHOLD_BYTES = 1024 * 1024; // 1MB

interface LoadedFile {
  /** Path the entry corresponds to — used to detect stale loads. */
  path: string;
  kind: FileKind;
  /** For text files. */
  content?: string;
  /** For image / pdf / video. */
  bytes?: FileBytes;
  /** Bytes on disk. */
  size: number;
  /** Original disk content for text — used to compute "modified" badge. */
  originalContent?: string;
  /** Set when we asked the user to confirm a >1MB load. */
  oversizeAccepted?: boolean;
  loading: boolean;
  error: string | null;
}

export function FilesPane({ projectPath, fileTree, openFiles }: Props): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= SIDEBAR_MIN_WIDTH ? stored : SIDEBAR_DEFAULT_WIDTH;
  });
  // Per-tab state. Keyed by path so we don't re-fetch on tab switches.
  const [loaded, setLoaded] = useState<Record<string, LoadedFile>>({});
  // Per-tab unsaved (pending) edits buffer for text files.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingPath, setSavingPath] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  // Resize handle for the inner left tree column.
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWRef = useRef(0);
  const onResizeStart = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWRef.current = sidebarWidth;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    },
    [sidebarWidth],
  );
  useEffect(() => {
    function onMove(e: MouseEvent): void {
      if (!draggingRef.current) return;
      const dx = e.clientX - startXRef.current;
      const next = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startWRef.current + dx),
      );
      setSidebarWidth(next);
    }
    function onUp(): void {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Discard cached loads / edits for files that are no longer open.
  useEffect(() => {
    const openPaths = new Set(openFiles.files.map((f) => f.path));
    setLoaded((prev) => {
      let changed = false;
      const next: Record<string, LoadedFile> = {};
      for (const [path, value] of Object.entries(prev)) {
        if (openPaths.has(path)) {
          next[path] = value;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setEdits((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [path, value] of Object.entries(prev)) {
        if (openPaths.has(path)) {
          next[path] = value;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [openFiles.files]);

  const activeFile = openFiles.activeIndex >= 0 ? openFiles.files[openFiles.activeIndex] : null;
  const activePath = activeFile?.path ?? null;
  const activeLoaded = activePath ? loaded[activePath] : undefined;
  const activeEdit = activePath ? edits[activePath] : undefined;
  const activeIsDirty =
    activeLoaded?.kind === 'text' &&
    activeEdit !== undefined &&
    activeLoaded.originalContent !== undefined &&
    activeEdit !== activeLoaded.originalContent;

  // Lazy-load the active file when it becomes active or content changes.
  // We re-fetch only when the path enters with no entry, or after the user
  // accepted the oversize prompt.
  const loadFile = useCallback(
    async (path: string, oversizeAccepted = false): Promise<void> => {
      console.debug('[Deepthix][FilesPane] loadFile', { path, oversizeAccepted });
      setLoaded((prev) => ({
        ...prev,
        [path]: {
          path,
          kind: 'unknown',
          size: prev[path]?.size ?? 0,
          loading: true,
          error: null,
          oversizeAccepted: oversizeAccepted || prev[path]?.oversizeAccepted,
        },
      }));
      try {
        const [kind, size] = await Promise.all([cmdFileKind(path), cmdFileSize(path)]);
        // Gate large files behind a confirm.
        if (!oversizeAccepted && size > LARGE_FILE_THRESHOLD_BYTES) {
          console.debug('[Deepthix][FilesPane] file >1MB, gating', { path, size });
          setLoaded((prev) => ({
            ...prev,
            [path]: {
              path,
              kind,
              size,
              loading: false,
              error: null,
              oversizeAccepted: false,
            },
          }));
          return;
        }
        if (kind === 'text') {
          const content = await cmdReadFile(path);
          setLoaded((prev) => ({
            ...prev,
            [path]: {
              path,
              kind,
              size,
              content,
              originalContent: content,
              loading: false,
              error: null,
              oversizeAccepted,
            },
          }));
          // Seed the edits buffer with the on-disk content.
          setEdits((prev) => ({ ...prev, [path]: content }));
        } else if (kind === 'image' || kind === 'pdf' || kind === 'video') {
          const bytes = await cmdReadFileBytes(path);
          setLoaded((prev) => ({
            ...prev,
            [path]: {
              path,
              kind,
              size,
              bytes,
              loading: false,
              error: null,
              oversizeAccepted,
            },
          }));
        } else {
          // 'unknown' — don't load bytes, just show a placeholder.
          setLoaded((prev) => ({
            ...prev,
            [path]: {
              path,
              kind,
              size,
              loading: false,
              error: null,
              oversizeAccepted,
            },
          }));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][FilesPane] load failed', { path, msg });
        setLoaded((prev) => ({
          ...prev,
          [path]: {
            path,
            kind: 'unknown',
            size: 0,
            loading: false,
            error: msg,
            oversizeAccepted,
          },
        }));
      }
    },
    [],
  );

  // Trigger lazy load when the active path changes (and we don't have it yet).
  useEffect(() => {
    if (!activePath) return;
    const entry = loaded[activePath];
    if (!entry) {
      void loadFile(activePath);
    }
  }, [activePath, loaded, loadFile]);

  // Save active file (text only). Returns true on success.
  const onSaveActive = useCallback(async (): Promise<boolean> => {
    if (!activePath) return false;
    const entry = loaded[activePath];
    if (!entry || entry.kind !== 'text') return false;
    const content = edits[activePath];
    if (content === undefined) return false;
    setSavingPath(activePath);
    try {
      console.info('[Deepthix][FilesPane] save', {
        path: activePath,
        bytes: content.length,
      });
      await cmdWriteFile(activePath, content);
      setLoaded((prev) => {
        const cur = prev[activePath];
        if (!cur) return prev;
        return { ...prev, [activePath]: { ...cur, originalContent: content } };
      });
      return true;
    } catch (e) {
      console.error('[Deepthix][FilesPane] save failed', e);
      setLoaded((prev) => {
        const cur = prev[activePath];
        if (!cur) return prev;
        return {
          ...prev,
          [activePath]: { ...cur, error: e instanceof Error ? e.message : String(e) },
        };
      });
      return false;
    } finally {
      setSavingPath(null);
    }
  }, [activePath, loaded, edits]);

  // Cmd/Ctrl+S in the textarea (or anywhere when this pane is active).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        if (!activePath) return;
        const entry = loaded[activePath];
        if (entry?.kind !== 'text') return;
        e.preventDefault();
        void onSaveActive();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activePath, loaded, onSaveActive]);

  // Close handler with confirm-if-dirty.
  const onCloseTab = useCallback(
    (index: number): void => {
      const f = openFiles.files[index];
      if (!f) return;
      const entry = loaded[f.path];
      const edit = edits[f.path];
      const dirty =
        entry?.kind === 'text' &&
        entry.originalContent !== undefined &&
        edit !== undefined &&
        edit !== entry.originalContent;
      if (dirty) {
        const ok = window.confirm(`Discard unsaved changes to ${basename(f.path)}?`);
        if (!ok) return;
      }
      openFiles.close(index);
    },
    [openFiles, loaded, edits],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        background: 'var(--color-bg)',
        fontFamily: 'var(--font-pixel)',
        overflow: 'hidden',
      }}
    >
      {/* LEFT: search + tree */}
      <div
        style={{
          width: `${sidebarWidth}px`,
          minWidth: `${SIDEBAR_MIN_WIDTH}px`,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '2px solid var(--color-border)',
          background: 'var(--color-bg)',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 8px',
            background: 'var(--color-bg-dark)',
            borderBottom: '2px solid var(--color-border)',
          }}
        >
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter files…"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '4px 8px',
              background: 'var(--color-bg)',
              color: 'var(--color-text)',
              border: '2px solid var(--color-border)',
              outline: 'none',
              fontFamily: 'var(--font-pixel)',
              fontSize: '0.8125rem',
            }}
          />
          <button
            type="button"
            onClick={() => void fileTree.refresh()}
            disabled={fileTree.loading || !fileTree.root}
            style={{
              padding: '4px 8px',
              background: 'transparent',
              color: 'inherit',
              border: '2px solid var(--color-border)',
              cursor: 'pointer',
              fontFamily: 'var(--font-pixel)',
              fontSize: '0.75rem',
            }}
            title="Refresh"
            aria-label="Refresh file tree"
          >
            ⟳
          </button>
        </div>
        <FileTree
          tree={fileTree}
          onFileClick={(p) => openFiles.open(p)}
          filter={search}
          hideHeader
        />
      </div>
      {/* Resize handle */}
      <div
        onMouseDown={onResizeStart}
        title="Drag to resize tree column"
        style={{
          width: '6px',
          cursor: 'ew-resize',
          background: 'var(--color-border)',
          flexShrink: 0,
        }}
      />
      {/* RIGHT: tab strip + content */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-bg)',
        }}
      >
        <TabStrip
          openFiles={openFiles}
          loaded={loaded}
          edits={edits}
          onCloseTab={onCloseTab}
        />
        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          {!projectPath && (
            <EmptyMessage>Open a project from the sidebar to browse its files.</EmptyMessage>
          )}
          {projectPath && openFiles.files.length === 0 && (
            <EmptyMessage>
              Click a file in the tree (or sidebar) to open it in a tab.
            </EmptyMessage>
          )}
          {activePath && (
            <FileContent
              path={activePath}
              entry={activeLoaded}
              editValue={activeEdit}
              isDirty={activeIsDirty}
              isSaving={savingPath === activePath}
              onChange={(v) => setEdits((prev) => ({ ...prev, [activePath]: v }))}
              onSave={() => void onSaveActive()}
              onLoadAnyway={() => void loadFile(activePath, true)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tab strip ─────────────────────────────────────────────────────────────

function TabStrip({
  openFiles,
  loaded,
  edits,
  onCloseTab,
}: {
  openFiles: UseOpenFilesResult;
  loaded: Record<string, LoadedFile>;
  edits: Record<string, string>;
  onCloseTab: (index: number) => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        background: 'var(--color-bg-dark)',
        borderBottom: '2px solid var(--color-border)',
        padding: '0 4px',
        gap: '2px',
        minHeight: '32px',
        flexShrink: 0,
        overflowX: 'auto',
      }}
    >
      {openFiles.files.length === 0 && (
        <span style={{ opacity: 0.55, padding: '0 8px', fontSize: '0.75rem' }}>(no files open)</span>
      )}
      {openFiles.files.map((f, i) => {
        const isActive = i === openFiles.activeIndex;
        const entry = loaded[f.path];
        const edit = edits[f.path];
        const dirty =
          entry?.kind === 'text' &&
          entry.originalContent !== undefined &&
          edit !== undefined &&
          edit !== entry.originalContent;
        return (
          <div
            key={f.path}
            onClick={() => openFiles.setActive(i)}
            style={{
              padding: '6px 10px',
              background: isActive ? 'var(--color-accent)' : 'transparent',
              color: isActive ? 'var(--color-bg-dark)' : 'inherit',
              border: '2px solid var(--color-border)',
              cursor: 'pointer',
              fontFamily: 'var(--font-pixel)',
              fontSize: '0.8125rem',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              maxWidth: '240px',
              flexShrink: 0,
            }}
            title={f.path}
          >
            <span
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {basename(f.path)}
              {dirty && <span style={{ marginLeft: 4, opacity: 0.85 }}>•</span>}
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(i);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  onCloseTab(i);
                }
              }}
              style={{ opacity: 0.7, padding: '0 2px', fontSize: '0.875rem' }}
              aria-label={`Close ${basename(f.path)}`}
              title="Close"
            >
              ×
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── File content ─────────────────────────────────────────────────────────

function FileContent({
  path,
  entry,
  editValue,
  isDirty,
  isSaving,
  onChange,
  onSave,
  onLoadAnyway,
}: {
  path: string;
  entry: LoadedFile | undefined;
  editValue: string | undefined;
  isDirty: boolean;
  isSaving: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  onLoadAnyway: () => void;
}): React.JSX.Element {
  if (!entry || entry.loading) {
    return <EmptyMessage>Loading {basename(path)}…</EmptyMessage>;
  }
  if (entry.error) {
    return (
      <EmptyMessage>
        <span style={{ color: 'var(--color-danger)' }}>Error: {entry.error}</span>
      </EmptyMessage>
    );
  }
  // Oversize gate.
  if (entry.size > 1024 * 1024 && !entry.oversizeAccepted) {
    return (
      <EmptyMessage>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <div>
            This file is {(entry.size / 1024 / 1024).toFixed(2)} MB.
            <br />
            Loading huge files can hang the UI.
          </div>
          <button
            type="button"
            onClick={onLoadAnyway}
            style={{
              padding: '6px 14px',
              background: 'var(--color-accent)',
              color: 'var(--color-bg-dark)',
              border: '2px solid var(--color-border)',
              boxShadow: 'var(--shadow-pixel)',
              cursor: 'pointer',
              fontFamily: 'var(--font-pixel)',
              fontSize: '0.8125rem',
            }}
          >
            Open anyway
          </button>
        </div>
      </EmptyMessage>
    );
  }
  if (entry.kind === 'text') {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 8px',
            background: 'var(--color-bg-dark)',
            borderBottom: '2px solid var(--color-border)',
            fontSize: '0.75rem',
            opacity: 0.85,
          }}
        >
          <span
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={path}
          >
            {path} {isDirty && <span style={{ opacity: 0.85 }}>•</span>}
          </span>
          <button
            type="button"
            onClick={onSave}
            disabled={!isDirty || isSaving}
            style={{
              padding: '4px 12px',
              background: isDirty && !isSaving ? 'var(--color-accent)' : 'transparent',
              color: isDirty && !isSaving ? 'var(--color-bg-dark)' : 'inherit',
              border: '2px solid var(--color-border)',
              boxShadow: isDirty && !isSaving ? 'var(--shadow-pixel)' : 'none',
              cursor: isDirty && !isSaving ? 'pointer' : 'default',
              opacity: isDirty ? 1 : 0.5,
              fontFamily: 'var(--font-pixel)',
              fontSize: '0.75rem',
            }}
            title="Save (Cmd+S)"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-bg)',
            overflow: 'hidden',
          }}
        >
          <CodeEditor
            path={path}
            value={editValue ?? entry.content ?? ''}
            onChange={onChange}
            onSave={onSave}
          />
        </div>
      </div>
    );
  }
  if (entry.kind === 'image' && entry.bytes) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          height: '100%',
          overflow: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'var(--color-bg-dark)',
        }}
      >
        <img
          src={`data:${entry.bytes.mime};base64,${entry.bytes.b64}`}
          alt={basename(path)}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            imageRendering: 'pixelated',
          }}
        />
      </div>
    );
  }
  if (entry.kind === 'pdf' && entry.bytes) {
    return <PdfViewer base64={entry.bytes.b64} />;
  }
  if (entry.kind === 'video' && entry.bytes) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'var(--color-bg-dark)',
        }}
      >
        <video
          src={`data:${entry.bytes.mime};base64,${entry.bytes.b64}`}
          controls
          style={{ maxWidth: '100%', maxHeight: '100%' }}
        >
          <track kind="captions" />
        </video>
      </div>
    );
  }
  // Unknown.
  return (
    <EmptyMessage>
      <div>
        Binary file — {entry.size.toLocaleString()} bytes.
        <br />
        <span style={{ opacity: 0.6 }}>(unsupported preview)</span>
      </div>
    </EmptyMessage>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function EmptyMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: 0.7,
        textAlign: 'center',
        padding: 24,
        fontSize: '0.875rem',
        lineHeight: 1.5,
        fontFamily: 'var(--font-pixel)',
      }}
    >
      {children}
    </div>
  );
}

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}
