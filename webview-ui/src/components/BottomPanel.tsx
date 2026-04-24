/* eslint-disable pixel-agents/no-inline-colors */
// BottomPanel: top mode-tabs (Sessions / Browser / Process), each renders
// its own pane below. The Sessions pane keeps the per-session sub-tabs and
// xterm; Browser is a per-session URL viewer; Process lists project node
// processes with kill buttons.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { UseTerminalsResult } from '../hooks/useTerminals';
import {
  killProcess as cmdKillProcess,
  listProcesses as cmdListProcesses,
  type ProcessInfo,
} from '../tauri/commands';
import { TerminalTab } from './TerminalTab';

const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 320;
const STORAGE_KEY = 'deepthix.bottomPanelHeight';

type Mode = 'sessions' | 'browser' | 'process';

interface Props {
  terminals: UseTerminalsResult;
  projectId: string | null;
  projectPath: string | null;
}

export function BottomPanel({ terminals, projectId, projectPath }: Props): React.JSX.Element | null {
  const visible = terminals.forProject(projectId);
  const effectiveActive: string | null = visible.some((t) => t.id === terminals.activeId)
    ? terminals.activeId
    : (visible[0]?.id ?? null);

  const [mode, setMode] = useState<Mode>('sessions');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [browserUrls, setBrowserUrls] = useState<Map<string, string>>(new Map());
  const [browserDraft, setBrowserDraft] = useState('http://localhost:3000');

  const [height, setHeight] = useState<number>(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
  });
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHRef = useRef(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(height));
  }, [height]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      draggingRef.current = true;
      startYRef.current = e.clientY;
      startHRef.current = height;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    },
    [height],
  );

  useEffect(() => {
    function onMove(e: MouseEvent): void {
      if (!draggingRef.current) return;
      const dy = startYRef.current - e.clientY;
      const next = Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 100, startHRef.current + dy));
      setHeight(next);
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

  // Hide the panel entirely when there's no project AND no terminals to keep alive.
  const hasContent = visible.length > 0 || mode !== 'sessions';
  if (!hasContent) return null;

  return (
    <div
      style={{
        height: `${height}px`,
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-pixel)',
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={onMouseDown}
        title="Drag to resize"
        style={{
          height: '6px',
          cursor: 'ns-resize',
          background: 'var(--color-border)',
          flexShrink: 0,
        }}
      />

      {/* Top mode tabs (Sessions / Browser / Process) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
          gap: '2px',
          padding: '0 4px',
          minHeight: '32px',
          flexShrink: 0,
        }}
      >
        {(['sessions', 'browser', 'process'] as const).map((m) => {
          const active = m === mode;
          return (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '6px 14px',
                background: active ? 'var(--color-accent)' : 'transparent',
                color: active ? 'var(--color-bg-dark)' : 'inherit',
                border: '2px solid var(--color-border)',
                cursor: 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '11px',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {m}
            </button>
          );
        })}
      </div>

      {/* Pane content */}
      {mode === 'sessions' && (
        <SessionsPane
          terminals={terminals}
          visible={visible}
          effectiveActive={effectiveActive}
          editingId={editingId}
          setEditingId={setEditingId}
          editingValue={editingValue}
          setEditingValue={setEditingValue}
        />
      )}
      {mode === 'browser' && (
        <BrowserPane
          sessionId={effectiveActive}
          sessions={visible}
          browserUrls={browserUrls}
          setBrowserUrls={setBrowserUrls}
          browserDraft={browserDraft}
          setBrowserDraft={setBrowserDraft}
        />
      )}
      {mode === 'process' && <ProcessPane projectPath={projectPath} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sessions pane — sub-tabs + xterm content (per-session)
// ─────────────────────────────────────────────────────────────────────────

interface SessionsPaneProps {
  terminals: UseTerminalsResult;
  visible: ReturnType<UseTerminalsResult['forProject']>;
  effectiveActive: string | null;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  editingValue: string;
  setEditingValue: (s: string) => void;
}

function SessionsPane({
  terminals,
  visible,
  effectiveActive,
  editingId,
  setEditingId,
  editingValue,
  setEditingValue,
}: SessionsPaneProps): React.JSX.Element {
  return (
    <>
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
        }}
      >
        {visible.map((t) => {
          const isActive = t.id === effectiveActive;
          const isEditing = editingId === t.id;
          return (
            <div
              key={t.id}
              onClick={() => !isEditing && terminals.setActive(t.id)}
              onDoubleClick={() => {
                setEditingId(t.id);
                setEditingValue(t.label);
              }}
              style={{
                padding: '6px 12px',
                background: isActive ? 'var(--color-accent)' : 'transparent',
                color: isActive ? 'var(--color-bg-dark)' : 'inherit',
                border: '2px solid var(--color-border)',
                cursor: isEditing ? 'text' : 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '11px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              title="Double-click to rename"
            >
              {isEditing ? (
                <input
                  autoFocus
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => {
                    terminals.rename(t.id, editingValue);
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      terminals.rename(t.id, editingValue);
                      setEditingId(null);
                    } else if (e.key === 'Escape') setEditingId(null);
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: '11px',
                    width: `${Math.max(60, editingValue.length * 8)}px`,
                    outline: 'none',
                  }}
                />
              ) : (
                <span>{t.label}</span>
              )}
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  void terminals.close(t.id);
                }}
                style={{ opacity: 0.7, padding: '0 2px' }}
                aria-label={`Close ${t.label}`}
              >
                ×
              </span>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div style={{ padding: '6px 12px', opacity: 0.6, fontSize: '11px' }}>
            No sessions in this project yet.
          </div>
        )}
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Mount EVERY terminal so xterm scrollback survives project switches. */}
        {terminals.terminals.map((t) => (
          <div
            key={t.id}
            style={{
              position: 'absolute',
              inset: 0,
              display: t.id === effectiveActive ? 'block' : 'none',
            }}
          >
            <TerminalTab termId={t.id} visible={t.id === effectiveActive} />
          </div>
        ))}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Browser pane — per-session URL + iframe
// ─────────────────────────────────────────────────────────────────────────

interface BrowserPaneProps {
  sessionId: string | null;
  sessions: ReturnType<UseTerminalsResult['forProject']>;
  browserUrls: Map<string, string>;
  setBrowserUrls: (m: Map<string, string>) => void;
  browserDraft: string;
  setBrowserDraft: (s: string) => void;
}

function BrowserPane({
  sessionId,
  sessions,
  browserUrls,
  setBrowserUrls,
  browserDraft,
  setBrowserDraft,
}: BrowserPaneProps): React.JSX.Element {
  const sessionUrl = sessionId ? (browserUrls.get(sessionId) ?? '') : '';
  const [draft, setDraft] = useState(sessionUrl || browserDraft);

  useEffect(() => {
    setDraft(sessionUrl || browserDraft);
  }, [sessionId, sessionUrl, browserDraft]);

  const go = (): void => {
    if (!sessionId) return;
    const next = new Map(browserUrls);
    next.set(sessionId, draft);
    setBrowserUrls(next);
    setBrowserDraft(draft);
  };

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 8px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
          flexShrink: 0,
        }}
      >
        <select
          value={sessionId ?? ''}
          onChange={() => { /* sessions are switched in the Sessions pane */ }}
          disabled
          style={{
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
            border: '2px solid var(--color-border)',
            padding: '4px 6px',
            fontFamily: 'var(--font-pixel)',
            fontSize: '11px',
          }}
        >
          {sessions.length === 0 && <option>No session</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
          placeholder="http://localhost:3000"
          style={{
            flex: 1,
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
            border: '2px solid var(--color-border)',
            padding: '4px 8px',
            fontFamily: 'var(--font-pixel)',
            fontSize: '11px',
          }}
        />
        <button
          onClick={go}
          disabled={!sessionId}
          style={{
            padding: '4px 12px',
            background: 'var(--color-accent)',
            color: 'var(--color-bg-dark)',
            border: '2px solid var(--color-border)',
            cursor: sessionId ? 'pointer' : 'not-allowed',
            fontFamily: 'var(--font-pixel)',
            fontSize: '11px',
          }}
        >
          GO
        </button>
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#fff' }}>
        {sessionUrl ? (
          <iframe
            key={`${sessionId}:${sessionUrl}`}
            src={sessionUrl}
            title={`browser-${sessionId}`}
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-text-muted)',
              fontSize: '12px',
              background: 'var(--color-bg)',
            }}
          >
            {sessionId
              ? 'Type a URL above and press GO.'
              : 'Open a session first to give it a browser.'}
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Process pane — list project node servers + kill / restart
// ─────────────────────────────────────────────────────────────────────────

function ProcessPane({ projectPath }: { projectPath: string | null }): React.JSX.Element {
  const [procs, setProcs] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectPath) {
      setProcs([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await cmdListProcesses(projectPath);
      setProcs(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const onKill = useCallback(
    async (pid: number) => {
      try {
        await cmdKillProcess(pid);
        await refresh();
      } catch (e) {
        console.error('[Deepthix][ProcessPane] kill failed', e);
      }
    },
    [refresh],
  );

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '8px', fontSize: '11px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          style={{
            padding: '4px 12px',
            background: 'transparent',
            color: 'inherit',
            border: '2px solid var(--color-border)',
            cursor: 'pointer',
            fontFamily: 'var(--font-pixel)',
            fontSize: '11px',
          }}
        >
          ⟳ refresh
        </button>
        <span style={{ opacity: 0.6 }}>
          {projectPath ? `${procs.length} processes related to ${projectPath}` : 'No project open.'}
        </span>
      </div>
      {error && <div style={{ color: 'var(--color-danger)', padding: '4px' }}>{error}</div>}
      {procs.length === 0 && !loading && projectPath && (
        <div style={{ opacity: 0.6, padding: '6px' }}>
          No matching processes. Auto-refresh every 4s.
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {procs.map((p) => (
            <tr key={p.pid} style={{ borderBottom: '1px solid var(--color-border)' }}>
              <td style={{ padding: '4px 6px', width: '70px', opacity: 0.7 }}>{p.pid}</td>
              <td
                style={{
                  padding: '4px 6px',
                  fontFamily: 'var(--font-pixel), Menlo, monospace',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '0',
                }}
                title={p.command}
              >
                {p.command}
              </td>
              <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                <button
                  onClick={() => void onKill(p.pid)}
                  style={{
                    padding: '2px 8px',
                    background: 'var(--color-danger)',
                    color: 'var(--color-bg-dark)',
                    border: '2px solid var(--color-border)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: '10px',
                  }}
                >
                  KILL
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
