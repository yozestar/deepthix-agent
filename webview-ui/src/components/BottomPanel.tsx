// Mode panes for the right-pane content area. Each pane is exported so
// App.tsx can mount the chosen one directly:
//
//   • SessionsPane  — per-session sub-tabs + xterm content (resizable bottom area)
//   • BrowserPane   — Chrome launcher (URL + viewport buttons + Open in Chrome)
//   • ProcessPane   — list project node-ish processes with kill buttons
//
// The 3 mode tabs themselves used to live here at the top of the panel; they
// have moved up to the App-level top header bar. This file no longer renders
// any tab strip — it only renders content panes.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  TERMINAL_FONT_FAMILY_PRESETS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_LINE_HEIGHT_STEP,
} from '../constants';
import type { TerminalSettings, UseTerminalsResult } from '../hooks/useTerminals';
import {
  killProcess as cmdKillProcess,
  listProcesses as cmdListProcesses,
  type ProcessInfo,
} from '../tauri/commands';
import { TerminalTab } from './TerminalTab';

const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 320;
const STORAGE_KEY = 'deepthix.bottomPanelHeight';

/** Round a line-height value to step precision (avoids 1.0500000001 jitter). */
function quantizeLineHeight(n: number): number {
  const stepped = Math.round(n / TERMINAL_LINE_HEIGHT_STEP) * TERMINAL_LINE_HEIGHT_STEP;
  return Math.min(TERMINAL_LINE_HEIGHT_MAX, Math.max(TERMINAL_LINE_HEIGHT_MIN, stepped));
}

// ─────────────────────────────────────────────────────────────────────────
// Sessions pane — sub-tabs + xterm content (per-session) + resizable height
// ─────────────────────────────────────────────────────────────────────────

interface SessionsPaneProps {
  terminals: UseTerminalsResult;
  projectId: string | null;
}

/**
 * Bottom resizable area for the Sessions mode: per-session sub-tabs at the
 * top + the xterm content for the active session below. The height is
 * persisted across reloads (localStorage). Returns null when there are no
 * visible sessions, so the tamagotchi can use the full main area.
 */
export function SessionsPane({ terminals, projectId }: SessionsPaneProps): React.JSX.Element | null {
  const visible = terminals.forProject(projectId);
  const effectiveActive: string | null = visible.some((t) => t.id === terminals.activeId)
    ? terminals.activeId
    : (visible[0]?.id ?? null);

  // Active session settings — drives the inline toolbar at the right end of
  // the sub-tab strip. Falls back to undefined when no session is active.
  const activeEntry = effectiveActive
    ? visible.find((t) => t.id === effectiveActive) ?? null
    : null;
  const activeSettings: TerminalSettings | null = activeEntry ? activeEntry.settings : null;

  const onSettingsChange = useCallback(
    (id: string, partial: Partial<TerminalSettings>): void => {
      console.debug('[Deepthix][SessionsPane] settings change', { id, partial });
      terminals.updateSettings(id, partial);
    },
    [terminals],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

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
      console.debug('[Deepthix][SessionsPane] resize start', { height });
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
        title="Drag to resize terminal area"
        style={{
          height: '6px',
          cursor: 'ns-resize',
          background: 'var(--color-border)',
          flexShrink: 0,
        }}
      />

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
                fontSize: '13px',
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

        {/* Per-session settings toolbar (Phase 10). Right-aligned inside
            the sub-tab strip via marginLeft:auto. Only shown when a
            session is active; mutations flow back via updateSettings →
            TerminalTab live-update + persistence. */}
        {activeEntry && activeSettings && (
          <SettingsToolbar
            settings={activeSettings}
            onChange={(partial) => onSettingsChange(activeEntry.id, partial)}
          />
        )}
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
            <TerminalTab
              termId={t.id}
              visible={t.id === effectiveActive}
              settings={t.settings}
              onSettingsChange={(partial) => onSettingsChange(t.id, partial)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Per-session terminal settings toolbar (Phase 10)
// ─────────────────────────────────────────────────────────────────────────

interface SettingsToolbarProps {
  settings: TerminalSettings;
  onChange: (partial: Partial<TerminalSettings>) => void;
}

/**
 * Compact inline toolbar shown at the right end of the sub-tab strip.
 * Three controls:
 *   • font size  (− value +) — clamps to TERMINAL_FONT_SIZE_MIN/MAX
 *   • font family (<select>) — preset list from constants
 *   • line height (− value +) — quantized to TERMINAL_LINE_HEIGHT_STEP
 */
function SettingsToolbar({ settings, onChange }: SettingsToolbarProps): React.JSX.Element {
  const bumpFont = useCallback(
    (delta: number) => {
      const next = Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, settings.fontSize + delta),
      );
      if (next !== settings.fontSize) onChange({ fontSize: next });
    },
    [onChange, settings.fontSize],
  );

  const bumpLineHeight = useCallback(
    (delta: number) => {
      const next = quantizeLineHeight(settings.lineHeight + delta);
      if (Math.abs(next - settings.lineHeight) > 1e-6) onChange({ lineHeight: next });
    },
    [onChange, settings.lineHeight],
  );

  const buttonStyle: React.CSSProperties = {
    width: '24px',
    minWidth: '24px',
    height: '24px',
    padding: 0,
    background: 'transparent',
    color: 'inherit',
    border: '2px solid var(--color-border)',
    cursor: 'pointer',
    fontFamily: 'var(--font-pixel)',
    fontSize: '13px',
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
  const valueStyle: React.CSSProperties = {
    minWidth: '32px',
    textAlign: 'center',
    fontFamily: 'var(--font-pixel)',
    fontSize: '12px',
    opacity: 0.8,
  };

  return (
    <div
      style={{
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 4px',
        fontFamily: 'var(--font-pixel)',
        fontSize: '12px',
      }}
    >
      <span style={{ opacity: 0.6, marginRight: '4px' }}>size</span>
      <button
        type="button"
        onClick={() => bumpFont(-1)}
        style={buttonStyle}
        title="Decrease font size (Cmd -)"
        aria-label="Decrease font size"
      >
        −
      </button>
      <span style={valueStyle} aria-label="Current font size">
        {settings.fontSize}
      </span>
      <button
        type="button"
        onClick={() => bumpFont(+1)}
        style={buttonStyle}
        title="Increase font size (Cmd =)"
        aria-label="Increase font size"
      >
        +
      </button>

      <span style={{ opacity: 0.6, marginLeft: '8px', marginRight: '4px' }}>font</span>
      <select
        value={settings.fontFamily}
        onChange={(e) => onChange({ fontFamily: e.target.value })}
        style={{
          background: 'var(--color-bg-dark)',
          color: 'inherit',
          border: '2px solid var(--color-border)',
          padding: '2px 4px',
          fontFamily: 'var(--font-pixel)',
          fontSize: '12px',
          height: '24px',
          cursor: 'pointer',
        }}
        title="Terminal font family"
      >
        {/* Show the current value as an extra option if it doesn't match
            any preset (e.g. older persisted custom value), so the dropdown
            never displays a blank label. */}
        {!TERMINAL_FONT_FAMILY_PRESETS.some((p) => p.value === settings.fontFamily) && (
          <option value={settings.fontFamily}>(custom)</option>
        )}
        {TERMINAL_FONT_FAMILY_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>

      <span style={{ opacity: 0.6, marginLeft: '8px', marginRight: '4px' }}>line</span>
      <button
        type="button"
        onClick={() => bumpLineHeight(-TERMINAL_LINE_HEIGHT_STEP)}
        style={buttonStyle}
        title="Decrease line height"
        aria-label="Decrease line height"
      >
        −
      </button>
      <span style={valueStyle} aria-label="Current line height">
        {settings.lineHeight.toFixed(2)}
      </span>
      <button
        type="button"
        onClick={() => bumpLineHeight(+TERMINAL_LINE_HEIGHT_STEP)}
        style={buttonStyle}
        title="Increase line height"
        aria-label="Increase line height"
      >
        +
      </button>
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
