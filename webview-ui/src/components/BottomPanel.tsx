// Mode panes for the right-pane content area. Each pane is exported so
// App.tsx can mount the chosen one directly:
//
//   • SessionsPane  — per-session sub-tabs + xterm content (resizable bottom area)
//   • ProcessPane   — list project node-ish processes with kill buttons
//
// The 3 mode tabs themselves used to live here at the top of the panel; they
// have moved up to the App-level top header bar. This file no longer renders
// any tab strip — it only renders content panes.
//
// Phase 11: per-session terminal settings have been promoted to a single
// global config (`useGlobalConfig`). The inline SettingsToolbar that used
// to sit at the right end of the sub-tab strip is gone; users edit the
// global font/zoom from the Sidebar's SETTINGS pane.

import { useCallback, useEffect, useRef, useState } from 'react';

import { useAgentStatus } from '../hooks/useAgentStatus';
import type { GlobalConfig } from '../hooks/useGlobalConfig';
import type { TerminalEntry, UseTerminalsResult } from '../hooks/useTerminals';
import {
  killProcess as cmdKillProcess,
  listProcesses as cmdListProcesses,
  type ProcessInfo,
} from '../tauri/commands';
import { ChatPane } from './ChatPane';
import { StatusDot } from './StatusDot';
import { TerminalTab } from './TerminalTab';

const MIN_HEIGHT = 160;
// Bumped from 320 → 480: 320 left the chat too small relative to the
// coach pane on top, and users had to drag the splitter up on every
// project switch. 480 gives the chat ~half the viewport on a 1080p
// screen out of the box. Persisted height in localStorage still wins.
const DEFAULT_HEIGHT = 480;
const STORAGE_KEY = 'deepthix.bottomPanelHeight';

// ─────────────────────────────────────────────────────────────────────────
// Sessions pane — sub-tabs + xterm content + resizable height
// ─────────────────────────────────────────────────────────────────────────

interface SessionsPaneProps {
  terminals: UseTerminalsResult;
  projectId: string | null;
  /** Global terminal config passed through to every TerminalTab (Phase 11). */
  globalConfig: GlobalConfig;
  /** Mutator for the global config — also wired into TerminalTab keyboard shortcuts. */
  updateGlobalConfig: (partial: Partial<GlobalConfig>) => void;
}

/**
 * Bottom resizable area for the Sessions mode: per-session sub-tabs at the
 * top + the xterm content for the active session below. The height is
 * persisted across reloads (localStorage). Returns null when there are no
 * visible sessions, so the tamagotchi can use the full main area.
 */
export function SessionsPane({
  terminals,
  projectId,
  globalConfig,
  updateGlobalConfig,
}: SessionsPaneProps): React.JSX.Element | null {
  const visible = terminals.forProject(projectId);
  const effectiveActive: string | null = visible.some((t) => t.id === terminals.activeId)
    ? terminals.activeId
    : (visible[0]?.id ?? null);

  const agentStatus = useAgentStatus();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  // Clamp the persisted height to the current viewport — without this,
  // a value saved on a big monitor (e.g. 720px) overflows past the
  // bottom of the screen on a smaller laptop and the composer
  // (Send / mic / textarea) gets cropped off-screen.
  // User report: "la fenêtre ne s'adapte pas à un petit écran je vois
  // pas le textarea".
  const maxHeightForViewport = (): number =>
    Math.max(MIN_HEIGHT, window.innerHeight - 140);

  const [height, setHeight] = useState<number>(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    const initial =
      Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
    return Math.min(initial, maxHeightForViewport());
  });
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHRef = useRef(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(height));
  }, [height]);

  // Re-clamp on viewport change (window resize, fullscreen toggle,
  // splitting Stage Manager). Prevents the composer from disappearing
  // when the user shrinks the window.
  useEffect(() => {
    function onResize(): void {
      setHeight((cur) => Math.min(cur, maxHeightForViewport()));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      draggingRef.current = true;
      startYRef.current = e.clientY;
      startHRef.current = height;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      console.debug('[Deepthix][SessionsPane] resize start', { height });
    },
    [height],
  );

  useEffect(() => {
    function onMove(e: MouseEvent): void {
      if (!draggingRef.current) return;
      const dy = startYRef.current - e.clientY;
      const next = Math.max(MIN_HEIGHT, Math.min(maxHeightForViewport(), startHRef.current + dy));
      setHeight(next);
    }
    function onUp(): void {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      console.debug('[Deepthix][SessionsPane] resize end');
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // When there are no visible sessions, hide the panel entirely so the
  // tamagotchi gets the whole main area.
  if (visible.length === 0) return null;

  // Drag handles + height state intentionally kept (line ~82-140) but
  // unused now that SessionsPane fills the parent — the old code split
  // the SESSIONS view between Coach (top) and chat (bottom). Coach was
  // removed, so the chat takes the full height via flex:1. The state
  // is harmless dead weight; re-wiring it would just bloat the diff.
  void height;
  void onMouseDown;
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-pixel)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >

      {/* Per-session sub-tab strip */}
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
        {visible.map((t: TerminalEntry) => {
          const isActive = t.id === effectiveActive;
          const isEditing = editingId === t.id;
          const status = t.kind === 'claude' ? agentStatus.status(t.agentId) : 'absent';
          return (
            <div
              key={t.id}
              onClick={() => !isEditing && terminals.setActive(t.id)}
              onDoubleClick={() => {
                setEditingId(t.id);
                setEditingValue(t.label);
              }}
              style={{
                padding: '5px 12px',
                background: isActive ? 'var(--color-bg)' : 'transparent',
                // Use --color-session-active (not --color-accent) so the
                // active sub-tab reads as a wayfinding indicator, not as
                // a CTA. Prevents visual confusion between "the pane I'm
                // in" and "the button to click".
                color: isActive ? 'var(--color-session-active)' : 'var(--color-text-muted)',
                border: 'none',
                borderTop: `2px solid ${isActive ? 'var(--color-session-active)' : 'transparent'}`,
                cursor: isEditing ? 'text' : 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '12px',
                fontWeight: isActive ? 'bold' : 'normal',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'color 120ms ease, border-color 120ms ease, background 120ms ease',
              }}
              title="Double-click to rename"
            >
              {/* Status dot before each label (Phase 11). Hidden for shells
                  since their `status` is always 'absent'. */}
              {t.kind === 'claude' && (
                <StatusDot
                  status={status}
                  title={`${t.label} — ${status}`}
                />
              )}
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
                    fontSize: '13px',
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
      </div>

      {/* xterm content (one node per terminal, hidden via display:none for inactive). */}
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
            {t.kind === 'claude' ? (
              // Plain ChatPane now — the Coach moved up to the
              // SESSIONS top area (where the bouncing brains used to
              // live). One responsibility per surface.
              //
              // onSessionReady fires when claude emits its system/init
              // event with the real session_id. We feed it back to
              // useTerminals so the entry gets persisted with the
              // right id (otherwise fresh sessions vanish on next
              // launch — they were never saved with a non-null id).
              <ChatPane
                cwd={t.cwd}
                resumeSessionId={t.sessionId}
                skipPermissions={t.skipPermissions}
                bindTermId={t.id}
                agentId={t.agentId}
                maxMessages={globalConfig.maxMessagesPerSession}
                onSessionReady={({ termId, sessionId }) => {
                  if (sessionId) terminals.setSessionId(termId, sessionId);
                }}
              />
            ) : (
              <TerminalTab
                // Including fontFamily in the React key forces a full xterm
                // re-mount when the user picks a new font. xterm 5.3's canvas
                // renderer caches a glyph atlas built from the original font
                // — flipping `term.options.fontFamily` updates the option but
                // the atlas keeps drawing the OLD glyphs (visible bug: nothing
                // changes on screen until the terminal is recreated). Because
                // we persist + restore scrollback by sessionId, the user
                // doesn't lose their conversation across this remount.
                key={`${t.id}::${globalConfig.terminalFontFamily}`}
                termId={t.id}
                visible={t.id === effectiveActive}
                settings={globalConfig}
                onSettingsChange={updateGlobalConfig}
                projectId={t.projectId}
                sessionId={t.sessionId}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Process pane — list project node servers + kill / restart
// ─────────────────────────────────────────────────────────────────────────

interface ProcessPaneProps {
  projectPath: string | null;
}

export function ProcessPane({ projectPath }: ProcessPaneProps): React.JSX.Element {
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
      console.debug('[Deepthix][ProcessPane] refreshed', { count: list.length });
      setProcs(list);
    } catch (e) {
      console.error('[Deepthix][ProcessPane] refresh failed', e);
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
        console.info('[Deepthix][ProcessPane] killed', { pid });
        await refresh();
      } catch (e) {
        console.error('[Deepthix][ProcessPane] kill failed', e);
      }
    },
    [refresh],
  );

  return (
    <div
      style={{
        flex: 1,
        overflow: 'auto',
        padding: '8px',
        fontSize: '13px',
        background: 'var(--color-bg)',
        fontFamily: 'var(--font-pixel)',
      }}
    >
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
            fontSize: '13px',
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
                    fontSize: '12px',
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
