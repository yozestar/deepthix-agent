// Mode panes for the right-pane content area. Each pane is exported so
// App.tsx can mount the chosen one directly:
//
//   • SessionsPane  — per-session sub-tabs + xterm content (resizable bottom area)
//   • BrowserPane   — Embedded Chrome launcher (real Chrome `--app=URL` window
//                      overlaid on the placeholder, positioned via AppleScript)
//   • ProcessPane   — list project node-ish processes with kill buttons
//
// The 3 mode tabs themselves used to live here at the top of the panel; they
// have moved up to the App-level top header bar. This file no longer renders
// any tab strip — it only renders content panes.

import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { UseTerminalsResult } from '../hooks/useTerminals';
import {
  closeEmbeddedBrowser as cmdCloseEmbeddedBrowser,
  killProcess as cmdKillProcess,
  listProcesses as cmdListProcesses,
  openChrome as cmdOpenChrome,
  positionEmbeddedBrowser as cmdPositionEmbeddedBrowser,
  type ProcessInfo,
  spawnEmbeddedBrowser as cmdSpawnEmbeddedBrowser,
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
 *
 * GO spawns the user's real Chrome in `--app=URL` mode and overlays it on
 * the iframe-shaped placeholder below. The Rust side (commands::embedded_browser)
 * keeps the Chrome window's bounds in sync via AppleScript whenever this
 * component's container resizes or the parent Tauri window moves/resizes.
 *
 * Each session remembers its own last URL (per terminal id), persisted to
 * localStorage so the URL survives reloads.
 *
 * macOS only — see CLAUDE.md note in the Rust module about why.
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
  // When set, an embedded Chrome window is being tracked. We render a
  // placeholder div instead of an iframe and keep Chrome's bounds in sync.
  const [embeddedId, setEmbeddedId] = useState<string | null>(null);
  // Ref to the placeholder div so we can read its on-screen rect.
  const placeholderRef = useRef<HTMLDivElement | null>(null);

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

  /** True for URLs that typically allow iframing (localhost / 127.* / file://). */
  const isLocalish = (url: string): boolean => {
    return /^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|file:)/i.test(
      url,
    );
  };

  // The URL that's actively shown (committed via Enter / GO). Used as the
  // input to spawnEmbeddedBrowser as well as for status text.
  const [loadedUrl, setLoadedUrl] = useState<string>(sessionUrl);
  useEffect(() => {
    setLoadedUrl(sessionUrl);
  }, [sessionUrl]);

  /**
   * Compute the screen-space (logical px, top-left origin) rect of the
   * iframe placeholder. AppleScript's `set bounds` expects exactly these
   * coordinates, so we keep the math here in JS and pass plain ints to Rust.
   */
  const computePlaceholderRect = useCallback(async (): Promise<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null> => {
    const el = placeholderRef.current;
    if (!el) {
      console.warn('[Deepthix][BrowserPane] computePlaceholderRect: ref not set');
      return null;
    }
    const rect = el.getBoundingClientRect();
    const win = getCurrentWindow();
    const [pos, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
    // Tauri's outerPosition is in PHYSICAL pixels; AppleScript expects LOGICAL
    // points (top-left origin). Divide by scale factor. Then add the CSS-px
    // rect offset within the window.
    const winLogicalX = pos.x / scale;
    const winLogicalY = pos.y / scale;
    // The webview is inset slightly inside the OS window (titlebar etc.) but
    // since outerPosition is the OS window's top-left and rect.left is the
    // CSS coord within the webview (which fills the OS window content area),
    // we approximate by adding rect coords directly. macOS Tauri windows
    // typically have a 28px titlebar; rect.top already accounts for any
    // in-page chrome we draw.
    const x = Math.round(winLogicalX + rect.left);
    const y = Math.round(winLogicalY + rect.top);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    return { x, y, w, h };
  }, []);

  /** Re-sync Chrome's bounds to wherever our placeholder currently sits. */
  const syncEmbeddedPosition = useCallback(
    async (id: string): Promise<void> => {
      const rect = await computePlaceholderRect();
      if (!rect) return;
      try {
        await cmdPositionEmbeddedBrowser(id, rect.x, rect.y, rect.w, rect.h);
      } catch (e) {
        // The Chrome window may have been closed by the user — surface as a
        // soft error and drop the tracked id so the UI returns to "no
        // embedded browser" state.
        console.warn('[Deepthix][BrowserPane] positionEmbeddedBrowser failed', e);
      }
    },
    [computePlaceholderRect],
  );

  // Watch the placeholder's own size (viewport switch, panel resize) and
  // resync Chrome bounds whenever it changes.
  useEffect(() => {
    if (!embeddedId) return;
    const el = placeholderRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      console.debug('[Deepthix][BrowserPane] placeholder resized — repositioning Chrome');
      void syncEmbeddedPosition(embeddedId);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [embeddedId, syncEmbeddedPosition]);

  // Watch the parent Tauri window for moves/resizes and resync.
  useEffect(() => {
    if (!embeddedId) return;
    const win = getCurrentWindow();
    let unMove: (() => void) | null = null;
    let unResize: (() => void) | null = null;
    void (async () => {
      unMove = await win.onMoved(() => {
        void syncEmbeddedPosition(embeddedId);
      });
      unResize = await win.onResized(() => {
        void syncEmbeddedPosition(embeddedId);
      });
    })();
    return () => {
      unMove?.();
      unResize?.();
    };
  }, [embeddedId, syncEmbeddedPosition]);

  // On unmount of BrowserPane (mode switch away from BROWSER), hide the
  // Chrome window so it doesn't float over the rest of the app. App.tsx
  // remounts BrowserPane on mode return — we re-show on next GO. (Persisting
  // the embeddedId across remounts is intentionally not implemented; if the
  // user wants to keep using Chrome they can stay on this tab.)
  useEffect(() => {
    return () => {
      if (embeddedId) {
        console.debug('[Deepthix][BrowserPane] unmount — closing embedded Chrome', { embeddedId });
        // Use close (not hide) since we lose the id on unmount anyway.
        void cmdCloseEmbeddedBrowser(embeddedId).catch((e) => {
          console.warn('[Deepthix][BrowserPane] close on unmount failed', e);
        });
      }
    };
    // We intentionally only depend on embeddedId so that the cleanup uses
    // the current id; recreating the closure on every render is fine.
  }, [embeddedId]);

  const onGo = async (): Promise<void> => {
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
    // Close any existing embedded browser first (URL change → fresh window).
    if (embeddedId) {
      try {
        await cmdCloseEmbeddedBrowser(embeddedId);
      } catch (e) {
        console.warn('[Deepthix][BrowserPane] close before respawn failed', e);
      }
      setEmbeddedId(null);
    }
    // Wait one tick so the placeholder div lays out at the new viewport size
    // before we read its rect.
    await new Promise((r) => setTimeout(r, 0));
    const rect = await computePlaceholderRect();
    if (!rect) {
      setError('Could not measure placeholder rect.');
      return;
    }
    setLaunching(true);
    try {
      console.info('[Deepthix][BrowserPane] spawning embedded Chrome', { url, ...rect });
      const handle = await cmdSpawnEmbeddedBrowser(url, rect.x, rect.y, rect.w, rect.h);
      setEmbeddedId(handle.id);
      setLastLaunched(`${url} (embedded ${rect.w}×${rect.h})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][BrowserPane] spawnEmbeddedBrowser failed', e);
      setError(msg);
    } finally {
      setLaunching(false);
    }
  };

  const onClose = async (): Promise<void> => {
    if (!embeddedId) return;
    try {
      await cmdCloseEmbeddedBrowser(embeddedId);
    } catch (e) {
      console.warn('[Deepthix][BrowserPane] close failed', e);
    }
    setEmbeddedId(null);
    setLastLaunched(null);
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

  // Ref helper: re-sync once whenever the placeholder mounts (handles
  // initial paint and StrictMode double-mount). The
  // `cmdShowEmbeddedBrowser` command is exported by the wrapper for future
  // use if we ever decide to keep the Chrome window alive across tab
  // switches; today the unmount-close path makes that unnecessary.
  const setPlaceholderRef = (el: HTMLDivElement | null): void => {
    placeholderRef.current = el;
    if (el && embeddedId) {
      // Defer one frame so layout settles.
      requestAnimationFrame(() => void syncEmbeddedPosition(embeddedId));
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
            if (e.key === 'Enter') void onGo();
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
            fontSize: '13px',
            outline: 'none',
          }}
        />
        <button
          onClick={() => void onGo()}
          disabled={launching}
          style={{
            padding: '4px 12px',
            background: 'var(--color-accent)',
            color: 'var(--color-bg-dark)',
            border: '2px solid var(--color-border)',
            cursor: launching ? 'wait' : 'pointer',
            fontFamily: 'var(--font-pixel)',
            fontSize: '13px',
          }}
        >
          {launching ? '…' : 'GO'}
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
                  fontSize: '12px',
                }}
                title={`${VIEWPORT_SIZES[vk].w}×${VIEWPORT_SIZES[vk].h}`}
              >
                {VIEWPORT_SIZES[vk].label}
              </button>
            );
          })}
        </div>
        {embeddedId && (
          <button
            onClick={() => void onClose()}
            title="Close the embedded Chrome window"
            style={{
              padding: '4px 8px',
              background: 'var(--color-danger)',
              color: 'var(--color-bg-dark)',
              border: '2px solid var(--color-border)',
              cursor: 'pointer',
              fontFamily: 'var(--font-pixel)',
              fontSize: '12px',
              marginLeft: '6px',
            }}
          >
            × close
          </button>
        )}
        <button
          onClick={() => void openInChromeExternal()}
          disabled={launching || !loadedUrl}
          title="Open the same URL in a separate, untracked Chrome window"
          style={{
            padding: '4px 8px',
            background: 'transparent',
            color: 'inherit',
            border: '2px solid var(--color-border)',
            cursor: launching ? 'wait' : 'pointer',
            fontFamily: 'var(--font-pixel)',
            fontSize: '12px',
            marginLeft: '6px',
            opacity: loadedUrl ? 1 : 0.5,
          }}
        >
          ↗ Chrome
        </button>
      </div>

      {/* Iframe area — the placeholder div reserves the space; real Chrome
          floats on top of it (positioned via AppleScript). When no embedded
          browser is active and the URL is local-ish we still drop an iframe
          inside as a quick preview. */}
      <div
        style={{
          flex: 1,
          background: 'var(--color-bg-dark)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          overflow: 'auto',
          padding: '12px',
        }}
      >
        {!embeddedId && loadedUrl && !isLocalish(loadedUrl) && (
          <div
            style={{
              width: '100%',
              maxWidth: `${v.w}px`,
              marginBottom: '8px',
              padding: '8px 12px',
              background: 'var(--color-warning)',
              color: 'var(--color-bg-dark)',
              border: '2px solid var(--color-border)',
              boxShadow: 'var(--shadow-pixel)',
              fontSize: '13px',
              fontFamily: 'var(--font-pixel)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
            }}
          >
            <span>
              External sites usually refuse to be framed. Press <strong>GO</strong> to spawn a real
              Chrome window overlaid on this area.
            </span>
            <button
              onClick={() => void openInChromeExternal()}
              disabled={launching}
              style={{
                padding: '4px 10px',
                background: 'var(--color-bg-dark)',
                color: 'var(--color-text)',
                border: '2px solid var(--color-border)',
                cursor: 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '12px',
              }}
            >
              ↗ Chrome
            </button>
          </div>
        )}
        {loadedUrl ? (
          <div
            ref={setPlaceholderRef}
            style={{
              width: `${v.w}px`,
              maxWidth: '100%',
              height: `${v.h}px`,
              maxHeight: '100%',
              border: '2px solid var(--color-border)',
              boxShadow: 'var(--shadow-pixel)',
              background: 'var(--color-bg)',
              flexShrink: 0,
              position: 'relative',
            }}
          >
            {embeddedId ? (
              // Visual placeholder while real Chrome floats on top. We deliberately
              // keep it empty (no iframe) so the GPU doesn't fight Chrome for the
              // pixels.
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--color-text-muted)',
                  fontSize: '12px',
                  pointerEvents: 'none',
                }}
              >
                {/* Visible if Chrome fails to render or briefly during reposition */}
                Chrome embedded — {loadedUrl}
              </div>
            ) : (
              <iframe
                key={`${sessionId ?? 'global'}:${loadedUrl}:${viewport}`}
                src={loadedUrl}
                title={`browser-${sessionId ?? 'global'}`}
                referrerPolicy="no-referrer"
                style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
              />
            )}
          </div>
        ) : (
          <div
            style={{
              alignSelf: 'center',
              color: 'var(--color-text-muted)',
              fontSize: '14px',
              textAlign: 'center',
              maxWidth: '420px',
              lineHeight: 1.6,
            }}
          >
            Type a URL above and press <strong>GO</strong>. A real Chrome window will appear
            embedded in this pane (using your default Chrome profile so extensions like
            claude-in-chrome MCP work).
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
            fontSize: '13px',
            display: 'flex',
            gap: '12px',
            flexShrink: 0,
          }}
        >
          {error && <span style={{ color: 'var(--color-danger)' }}>{error}</span>}
          {lastLaunched && !error && (
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
