// MemoryPane — read/write the per-project CLAUDE.md and the global
// ~/.claude/CLAUDE.md side by side. These files are the official Claude Code
// "memory" mechanism: anything in CLAUDE.md is loaded into Claude's system
// prompt for every session.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  readGlobalMemory as cmdReadGlobalMemory,
  readProjectMemory as cmdReadProjectMemory,
  writeGlobalMemory as cmdWriteGlobalMemory,
  writeProjectMemory as cmdWriteProjectMemory,
} from '../tauri/commands';

interface Props {
  projectPath: string | null;
}

const SAVED_INDICATOR_MS = 1500;

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

interface ColumnProps {
  title: string;
  subtitle: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void | Promise<void>;
  loadState: LoadState;
  error: string | null;
  saving: boolean;
  showSaved: boolean;
  disabled?: boolean;
  emptyState?: React.ReactNode;
}

function MemoryColumn({
  title,
  subtitle,
  value,
  onChange,
  onSave,
  loadState,
  error,
  saving,
  showSaved,
  disabled = false,
  emptyState,
}: ColumnProps): React.JSX.Element {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg)',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
          <span style={{ fontSize: '13px', letterSpacing: '0.05em' }}>{title}</span>
          <span
            style={{
              fontSize: '10px',
              opacity: 0.6,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={subtitle}
          >
            {subtitle}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {showSaved && (
            <span style={{ fontSize: '10px', color: 'var(--color-status-success)' }}>
              saved ✓
            </span>
          )}
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={disabled || saving || loadState !== 'ready'}
            style={{
              padding: '6px 14px',
              background: disabled || saving ? 'transparent' : 'var(--color-accent)',
              color: disabled || saving ? 'inherit' : 'var(--color-bg-dark)',
              border: '2px solid var(--color-border)',
              boxShadow: disabled || saving ? 'none' : 'var(--shadow-pixel)',
              cursor: disabled || saving ? 'default' : 'pointer',
              fontFamily: 'var(--font-pixel)',
              fontSize: '11px',
              opacity: disabled ? 0.5 : 1,
            }}
            title="Save CLAUDE.md"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div style={{ flex: 1, position: 'relative', display: 'flex' }}>
        {disabled && emptyState ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              fontSize: '12px',
              opacity: 0.7,
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            {emptyState}
          </div>
        ) : (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            disabled={loadState === 'loading'}
            placeholder={
              loadState === 'loading'
                ? 'Loading…'
                : '# CLAUDE.md\n\nWrite anything you want Claude to remember when working in this project.\n'
            }
            style={{
              flex: 1,
              resize: 'none',
              border: 'none',
              outline: 'none',
              background: 'var(--color-bg)',
              color: 'var(--color-text)',
              padding: '12px',
              fontFamily: 'var(--font-pixel), Menlo, Consolas, monospace',
              fontSize: '12px',
              lineHeight: 1.6,
            }}
          />
        )}
      </div>
      {error && (
        <div
          style={{
            padding: '6px 12px',
            fontSize: '11px',
            color: 'var(--color-danger)',
            borderTop: '2px solid var(--color-danger)',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function MemoryPane({ projectPath }: Props): React.JSX.Element {
  const [projectValue, setProjectValue] = useState('');
  const [globalValue, setGlobalValue] = useState('');
  const [projectLoadState, setProjectLoadState] = useState<LoadState>('idle');
  const [globalLoadState, setGlobalLoadState] = useState<LoadState>('idle');
  const [projectError, setProjectError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [projectSaving, setProjectSaving] = useState(false);
  const [globalSaving, setGlobalSaving] = useState(false);
  const [projectShowSaved, setProjectShowSaved] = useState(false);
  const [globalShowSaved, setGlobalShowSaved] = useState(false);

  // Auto-clear the "saved ✓" indicator after a short delay.
  useEffect(() => {
    if (!projectShowSaved) return;
    const t = setTimeout(() => setProjectShowSaved(false), SAVED_INDICATOR_MS);
    return () => clearTimeout(t);
  }, [projectShowSaved]);
  useEffect(() => {
    if (!globalShowSaved) return;
    const t = setTimeout(() => setGlobalShowSaved(false), SAVED_INDICATOR_MS);
    return () => clearTimeout(t);
  }, [globalShowSaved]);

  // Load project memory whenever the active project path changes.
  const lastLoadedProjectPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (projectPath === lastLoadedProjectPathRef.current) return;
    lastLoadedProjectPathRef.current = projectPath;
    if (!projectPath) {
      console.debug('[Deepthix][MemoryPane] no projectPath; clearing project value');
      setProjectValue('');
      setProjectLoadState('idle');
      setProjectError(null);
      return;
    }
    console.debug('[Deepthix][MemoryPane] loading project CLAUDE.md', { projectPath });
    setProjectLoadState('loading');
    setProjectError(null);
    cmdReadProjectMemory(projectPath)
      .then((s) => {
        console.debug('[Deepthix][MemoryPane] loaded project CLAUDE.md', { bytes: s.length });
        setProjectValue(s);
        setProjectLoadState('ready');
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][MemoryPane] read_project_memory failed', msg);
        setProjectError(msg);
        setProjectLoadState('error');
      });
  }, [projectPath]);

  // Load global memory once on mount.
  useEffect(() => {
    console.debug('[Deepthix][MemoryPane] loading global CLAUDE.md');
    setGlobalLoadState('loading');
    setGlobalError(null);
    cmdReadGlobalMemory()
      .then((s) => {
        console.debug('[Deepthix][MemoryPane] loaded global CLAUDE.md', { bytes: s.length });
        setGlobalValue(s);
        setGlobalLoadState('ready');
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][MemoryPane] read_global_memory failed', msg);
        setGlobalError(msg);
        setGlobalLoadState('error');
      });
  }, []);

  const onSaveProject = useCallback(async (): Promise<void> => {
    if (!projectPath) return;
    console.info('[Deepthix][MemoryPane] save project CLAUDE.md', {
      projectPath,
      bytes: projectValue.length,
    });
    setProjectSaving(true);
    setProjectError(null);
    try {
      await cmdWriteProjectMemory(projectPath, projectValue);
      setProjectShowSaved(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][MemoryPane] write_project_memory failed', msg);
      setProjectError(msg);
    } finally {
      setProjectSaving(false);
    }
  }, [projectPath, projectValue]);

  const onSaveGlobal = useCallback(async (): Promise<void> => {
    console.info('[Deepthix][MemoryPane] save global CLAUDE.md', { bytes: globalValue.length });
    setGlobalSaving(true);
    setGlobalError(null);
    try {
      await cmdWriteGlobalMemory(globalValue);
      setGlobalShowSaved(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][MemoryPane] write_global_memory failed', msg);
      setGlobalError(msg);
    } finally {
      setGlobalSaving(false);
    }
  }, [globalValue]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        background: 'var(--color-bg)',
        padding: '12px',
        display: 'flex',
        gap: '12px',
        overflow: 'hidden',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      <MemoryColumn
        title="PROJECT"
        subtitle={projectPath ? `${projectPath}/CLAUDE.md` : 'No project open'}
        value={projectValue}
        onChange={setProjectValue}
        onSave={onSaveProject}
        loadState={projectLoadState}
        error={projectError}
        saving={projectSaving}
        showSaved={projectShowSaved}
        disabled={!projectPath}
        emptyState={
          <span>
            Open a project from the sidebar to edit
            <br />
            its <strong>CLAUDE.md</strong> memory file.
          </span>
        }
      />
      <MemoryColumn
        title="GLOBAL"
        subtitle="~/.claude/CLAUDE.md"
        value={globalValue}
        onChange={setGlobalValue}
        onSave={onSaveGlobal}
        loadState={globalLoadState}
        error={globalError}
        saving={globalSaving}
        showSaved={globalShowSaved}
      />
    </div>
  );
}
