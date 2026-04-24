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

import type { UseTerminalsResult } from '../hooks/useTerminals';
import {
  killProcess as cmdKillProcess,
  listProcesses as cmdListProcesses,
  openChrome as cmdOpenChrome,
  type ProcessInfo,
} from '../tauri/commands';
import { TerminalTab } from './TerminalTab';

const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 320;
const STORAGE_KEY = 'deepthix.bottomPanelHeight';

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
            <TerminalTab termId={t.id} visible={t.id === effectiveActive} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Browser pane — Chrome launcher (per-session URL memory + viewport buttons)
// ─────────────────────────────────────────────────────────────────────────

type Viewport = 'mobile' | 'tablet' | 'desktop';
const VIEWPORT_SIZES: Record<Viewport, { w: number; h: number; label: string }> = {
  mobile:  { w: 375,  h: 667,  label: 'Mobile (375x667)' },
  tablet:  { w: 768,  h: 1024, label: 'Tablet (768x1024)' },
  desktop: { w: 1280, h: 800,  label: 'Desktop (1280x800)' },
};

const BROWSER_URL_STORAGE_KEY = 'deepthix.browserUrlsByTerminal.v1';

/** Load the per-terminal URL map from localStorage (best-effort; never throws). */
function loadStoredUrls(): Map<string, string> {
  try {
    const raw = localStorage.getItem(BROWSER_URL_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch (e) {
    console.warn('[Deepthix][BrowserPane] failed to read stored URLs', e);
    return new Map();
  }
}

function persistStoredUrls(m: Map<string, string>): void {
  try {
    localStorage.setItem(BROWSER_URL_STORAGE_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch (e) {
    console.warn('[Deepthix][BrowserPane] failed to persist URLs', e);
  }
}

interface BrowserPaneProps {
  terminals: UseTerminalsResult;
  projectId: string | null;
}

/**
 * Browser launcher pane (full-area). The Tauri WebView on macOS is WKWebView
 * (Safari engine), which is not what users want when developing for Chrome.
 * Instead of an iframe, we spawn the user's real Chrome via a backend command.
 *
 * Each session remembers its own last URL (per terminal id), persisted to
 * localStorage so the URL survives reloads.
 */
export function BrowserPane({ terminals, projectId }: BrowserPaneProps): React.JSX.Element {
  const visible = terminals.forProject(projectId);
  const sessionId: string | null = visible.some((t) => t.id === terminals.activeId)
    ? terminals.activeId
    : (visible[0]?.id ?? null);

  const [browserUrls, setBrowserUrls] = useState<Map<string, string>>(() => loadStoredUrls());
  const sessionUrl = sessionId ? (browserUrls.get(sessionId) ?? '') : '';

  const [draft, setDraft] = useState<string>(sessionUrl || 'http://localhost:3000');
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLaunched, setLastLaunched] = useState<string | null>(null);

  // When the user picks a different session in another pane, refresh the draft
  // to that session's last-known URL (or fall back to the current draft).
  useEffect(() => {
    if (!sessionId) return;
    const stored = browserUrls.get(sessionId);
    if (stored) setDraft(stored);
  }, [sessionId, browserUrls]);

  const onSelectViewport = (v: Viewport): void => {
    console.debug('[Deepthix][BrowserPane] viewport ->', v);
    setViewport(v);
  };

  const v = VIEWPORT_SIZES[viewport];

  // The URL that's actively rendered in the iframe (committed via Enter / GO).
  const [loadedUrl, setLoadedUrl] = useState<string>(sessionUrl);
  useEffect(() => {
    setLoadedUrl(sessionUrl);
  }, [sessionUrl]);

  const onGo = (): void => {
    const url = draft.trim();
    if (!url) {
      setError('Enter a URL.');
      return;
    }
    setError(null);
    setLoadedUrl(url);
    if (sessionId) {
      const next = new Map(browserUrls);
      next.set(sessionId, url);
      setBrowserUrls(next);
      persistStoredUrls(next);
    }
  };

  const openInChromeExternal = async (): Promise<void> => {
    const url = (loadedUrl || draft).trim();
    if (!url) return;
    setLaunching(true);
    try {
      await cmdOpenChrome(url, v.w, v.h);
      setLastLaunched(`${url} @ ${v.w}x${v.h}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div
      style={{
        flex: 1,
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-pixel)',
        overflow: 'hidden',
      }}
    >
      {/* Browser chrome bar */}
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
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onGo();
          }}
          placeholder="http://localhost:3000"
          spellCheck={false}
          style={{
            flex: 1,
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
            border: '2px solid var(--color-border)',
            padding: '4px 8px',
            fontFamily: 'var(--font-pixel)',
            fontSize: '11px',
            outline: 'none',
          }}
        />
        <button
          onClick={onGo}
          style={{
            padding: '4px 12px',
            background: 'var(--color-accent)',
            color: 'var(--color-bg-dark)',
            border: '2px solid var(--color-border)',
            cursor: 'pointer',
            fontFamily: 'var(--font-pixel)',
            fontSize: '11px',
          }}
        >
          GO
        </button>
        <div style={{ display: 'flex', gap: '2px', marginLeft: '6px' }}>
          {(Object.keys(VIEWPORT_SIZES) as Viewport[]).map((vk) => {
            const active = viewport === vk;
            return (
              <button
                key={vk}
                onClick={() => onSelectViewport(vk)}
                style={{
                  padding: '4px 8px',
                  background: active ? 'var(--color-accent)' : 'transparent',
                  color: active ? 'var(--color-bg-dark)' : 'inherit',
                  border: '2px solid var(--color-border)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-pixel)',
                  fontSize: '10px',
                }}
                title={`${VIEWPORT_SIZES[vk].w}×${VIEWPORT_SIZES[vk].h}`}
              >
                {VIEWPORT_SIZES[vk].label}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => void openInChromeExternal()}
          disabled={launching || !loadedUrl}
          title="Open the same URL in real Chrome (separate window)"
          style={{
            padding: '4px 8px',
            background: 'transparent',
            color: 'inherit',
            border: '2px solid var(--color-border)',
            cursor: launching ? 'wait' : 'pointer',
            fontFamily: 'var(--font-pixel)',
            fontSize: '10px',
            marginLeft: '6px',
            opacity: loadedUrl ? 1 : 0.5,
          }}
        >
          ↗ Chrome
        </button>
      </div>

      {/* Iframe area */}
      <div
        style={{
          flex: 1,
          background: 'var(--color-bg-dark)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          overflow: 'auto',
          padding: '12px',
        }}
      >
        {loadedUrl ? (
          <div
            style={{
              width: `${v.w}px`,
              maxWidth: '100%',
              height: `${v.h}px`,
              maxHeight: '100%',
              border: '2px solid var(--color-border)',
              boxShadow: 'var(--shadow-pixel)',
              background: 'var(--color-bg)',
              flexShrink: 0,
            }}
          >
            <iframe
              key={`${sessionId ?? 'global'}:${loadedUrl}:${viewport}`}
              src={loadedUrl}
              title={`browser-${sessionId ?? 'global'}`}
              style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            />
          </div>
        ) : (
          <div
            style={{
              alignSelf: 'center',
              color: 'var(--color-text-muted)',
              fontSize: '12px',
              textAlign: 'center',
              maxWidth: '420px',
              lineHeight: 1.6,
            }}
          >
            Type a URL above and press <strong>GO</strong>. The page renders inline at the chosen
            viewport. Some sites refuse to be framed; in that case use <strong>↗ Chrome</strong> to
            open in a real Chrome window.
            {sessionId && (
              <div style={{ marginTop: 12, opacity: 0.7 }}>
                URL is remembered per session ({visible.find((t) => t.id === sessionId)?.label ?? sessionId}).
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      {(lastLaunched || error) && (
        <div
          style={{
            padding: '6px 12px',
            background: 'var(--color-bg-dark)',
            borderTop: '2px solid var(--color-border)',
            fontSize: '11px',
            display: 'flex',
            gap: '12px',
            flexShrink: 0,
          }}
        >
          {error && <span style={{ color: 'var(--color-danger)' }}>{error}</span>}
          {lastLaunched && (
            <span style={{ color: 'var(--color-status-success)' }}>↗ {lastLaunched}</span>
          )}
        </div>
      )}
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
        fontSize: '11px',
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
