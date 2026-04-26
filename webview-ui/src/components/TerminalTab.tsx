import 'xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useCallback, useEffect, useRef } from 'react';
import { Terminal } from 'xterm';

import {
  TERMINAL_DEFAULT_BG,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from '../constants';
import type { GlobalConfig } from '../hooks/useGlobalConfig';
import {
  loadTerminalScrollback,
  openExternalUrl,
  ptyResize,
  ptyWrite,
  saveTerminalScrollback,
} from '../tauri/commands';
import { onPtyData, type PtyDataEvent } from '../tauri/events';

interface Props {
  termId: string;
  visible: boolean;
  /**
   * Global terminal settings (Phase 11). Promoted from per-session — every
   * tab now reads from the same `~/.deepthix/config.json`-backed hook so
   * font/zoom changes apply uniformly.
   */
  settings: GlobalConfig;
  /**
   * Called when the user changes settings *from inside the terminal*
   * (Cmd+=/Cmd+-/Cmd+0 keyboard shortcuts). The parent persists the new
   * value into `useGlobalConfig.update`, which flows back into our
   * `settings` prop and triggers the live-update effect.
   */
  onSettingsChange: (partial: Partial<GlobalConfig>) => void;
  /**
   * Owning project — used as the parent dir for the saved scrollback file.
   * Required when `sessionId` is set.
   */
  projectId: string;
  /**
   * Claude session id (claude `--resume` UUID). When present, scrollback is
   * loaded on mount + saved on unmount + saved every 30s, so reopening the
   * app shows the previous conversation. `null` for plain shells (no resume
   * concept → no point persisting their buffer).
   */
  sessionId: string | null;
}

/** How often to flush the live scrollback to disk while the terminal is mounted. */
const SCROLLBACK_AUTOSAVE_MS = 30_000;

function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return TERMINAL_DEFAULT_FONT_SIZE;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(n)));
}

export function TerminalTab({
  termId,
  visible,
  settings,
  onSettingsChange,
  projectId,
  sessionId,
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  // Latest projectId/sessionId in a ref so the autosave timer + unmount
  // effect (registered ONCE at mount) always read the current values.
  const projectIdRef = useRef(projectId);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  // Holds the latest `safeFit` callback so the mount-time ResizeObserver
  // (registered ONCE) can call the most recent version without depending
  // on it through React deps and re-creating the terminal.
  const safeFitRef = useRef<() => void>(() => {});

  // Stash the latest settings + onSettingsChange so the keydown handler
  // (registered once at mount) always sees the current values without
  // having to re-bind every render.
  const settingsRef = useRef<GlobalConfig>(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const onSettingsChangeRef = useRef(onSettingsChange);
  useEffect(() => {
    onSettingsChangeRef.current = onSettingsChange;
  }, [onSettingsChange]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      console.warn('[Deepthix][TerminalTab] no container ref', { termId });
      return;
    }
    console.debug('[Deepthix][TerminalTab] mount', {
      termId,
      fontSize: settingsRef.current.terminalFontSize,
      fontFamily: settingsRef.current.terminalFontFamily,
      lineHeight: settingsRef.current.terminalLineHeight,
    });
    // xterm renders to canvas → CSS vars don't resolve there. Read the
    // computed --color-bg from :root so the terminal background matches the
    // pixel-art palette without hardcoding the literal.
    const rootStyle = getComputedStyle(document.documentElement);
    const bgColor = rootStyle.getPropertyValue('--color-bg').trim() || TERMINAL_DEFAULT_BG;
    const term = new Terminal({
      fontSize: settingsRef.current.terminalFontSize,
      fontFamily: settingsRef.current.terminalFontFamily,
      lineHeight: settingsRef.current.terminalLineHeight,
      letterSpacing: 0,
      theme: { background: bgColor },
      // false: claude code (Ink-based TUI) sends its own \r\n sequences and
      // performs absolute cursor positioning — converting bare \n to \r\n
      // double-shifts the cursor and corrupts the input box border on
      // redraws (this was producing the visible "split prompt" rows).
      convertEol: false,
      // Bar cursor matches what Ink expects, and blinking ensures we always
      // see WHERE the input is (the static block was disappearing on
      // certain redraws because xterm assumed it owned the cursor cell).
      cursorStyle: 'bar',
      cursorBlink: true,
      // Re-affirm canvas-renderer defaults so a stale option from an HMR
      // patch can't leave us with a broken renderer.
      allowTransparency: false,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    // Web-links addon: detects http(s) URLs in the buffer and turns them
    // into hover-able / clickable hotspots. We intercept the click and
    // hand the URL off to the OS via `open_external_url` so it lands in
    // the user's default browser instead of the Tauri webview (which
    // would refuse external navigation anyway).
    const webLinks = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      void openExternalUrl(uri).catch((e) => {
        console.warn('[Deepthix][TerminalTab] open external url failed', { uri, e });
      });
    });
    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.loadAddon(webLinks);
    term.open(el);
    // The xterm canvas renderer initializes lazily — the first fit() can
    // throw `_renderer.value.dimensions` is undefined. Swallow it; the
    // subsequent ResizeObserver / visibility effects will retry.
    try {
      fit.fit();
    } catch (e) {
      console.debug('[Deepthix][TerminalTab] initial fit deferred', e);
    }
    termRef.current = term;
    fitRef.current = fit;
    serializeRef.current = serialize;

    const writeDisposable = term.onData((data) => {
      void ptyWrite(termId, data);
    });

    // Restore saved scrollback BEFORE pty data starts streaming. Buffer any
    // events that arrive while the load is in flight so we don't lose the
    // first few lines from the resumed claude session, then flush them
    // after the historical buffer has been written.
    let restored = sessionId == null; // shells (no sessionId) skip restore
    const buffered: string[] = [];

    let unlisten: (() => void) | null = null;
    void onPtyData((e: PtyDataEvent) => {
      if (e.id !== termId) return;
      if (!restored) {
        buffered.push(e.data);
      } else {
        term.write(e.data);
      }
      // NOTE: we used to dispatch a ptyActivity ping here as a fast
      // working-status signal, but claude TUI redraws (cursor blink,
      // rate-limit indicator, status footer animation) push bytes
      // through the pty even when claude is idle — making the dot
      // oscillate green→red on its own. The JSONL-size poll in
      // useTerminals is the source of truth now: only real new content
      // (thinking record, tool call, streamed message) grows the
      // transcript file, so it's a clean signal at the cost of ~2s
      // latency.
    }).then((fn) => {
      unlisten = fn;
    });

    if (sessionId) {
      void loadTerminalScrollback(projectId, sessionId)
        .then((content) => {
          if (content && content.length > 0) {
            console.info('[Deepthix][TerminalTab] restored scrollback', {
              termId,
              sessionId,
              bytes: content.length,
            });
            term.write(content);
            // Visual marker so users see WHERE the resumed buffer ends and
            // the live session continues.
            term.write('\r\n\x1b[2m── resumed ──\x1b[0m\r\n');
          }
        })
        .catch((err) => {
          console.warn('[Deepthix][TerminalTab] scrollback restore failed', err);
        })
        .finally(() => {
          restored = true;
          // Flush anything that arrived while we were loading.
          if (buffered.length > 0) {
            console.debug('[Deepthix][TerminalTab] flushing buffered pty data', {
              termId,
              chunks: buffered.length,
            });
            for (const chunk of buffered) term.write(chunk);
            buffered.length = 0;
          }
        });
    }

    // Periodic best-effort save while the terminal is open. The 30s
    // interval keeps disk churn modest even with several active sessions
    // while still bounding worst-case data loss to half a minute.
    const autosaveTimer = setInterval(() => {
      const sid = sessionIdRef.current;
      const pid = projectIdRef.current;
      const ser = serializeRef.current;
      if (!sid || !ser) return;
      try {
        const content = ser.serialize();
        void saveTerminalScrollback(pid, sid, content).catch((err) => {
          console.warn('[Deepthix][TerminalTab] autosave failed', err);
        });
      } catch (err) {
        console.warn('[Deepthix][TerminalTab] serialize during autosave failed', err);
      }
    }, SCROLLBACK_AUTOSAVE_MS);

    const resizeObserver = new ResizeObserver(() => {
      // Use safeFit so that fit() failures (xterm renderer not yet
      // initialized — common when this terminal is hidden via display:none
      // and another panel triggers a layout) don't leave us stuck at the
      // pre-resize geometry. Without try/catch the thrown
      // `_renderer.value.dimensions` would short-circuit the observer
      // callback and the terminal would silently keep its old size.
      safeFitRef.current();
    });
    resizeObserver.observe(el);

    // Keyboard shortcuts. Only fire when xterm has focus — xterm puts focus
    // on the .xterm-helper-textarea (a hidden textarea it owns), so we
    // attach to the container and check `el.contains(target)`. This keeps
    // Cmd+= / Cmd+- / Cmd+0 from hijacking other inputs (e.g. the
    // SessionsPane rename textbox or any sidebar search). The handler
    // mutates the GLOBAL config, so every other open terminal also rescales
    // — this is intentional in Phase 11.
    const containerEl: HTMLDivElement = el;
    function onKeyDown(ev: KeyboardEvent): void {
      // metaKey = Command on macOS. The app is macOS-only so we don't
      // bother to check ctrlKey for cross-platform parity.
      if (!ev.metaKey || ev.altKey || ev.ctrlKey) return;
      const target = ev.target as Node | null;
      if (!target || !containerEl.contains(target)) return;
      // Cmd+= and Cmd++  → font size +1. Both `=` and `+` are common
      // because shifted `=` produces `+` on US layouts; we accept either.
      if (ev.key === '=' || ev.key === '+') {
        ev.preventDefault();
        const next = clampFontSize(settingsRef.current.terminalFontSize + 1);
        if (next !== settingsRef.current.terminalFontSize) {
          console.debug('[Deepthix][TerminalTab] shortcut font+ ', { termId, next });
          onSettingsChangeRef.current({ terminalFontSize: next });
        }
        return;
      }
      if (ev.key === '-') {
        ev.preventDefault();
        const next = clampFontSize(settingsRef.current.terminalFontSize - 1);
        if (next !== settingsRef.current.terminalFontSize) {
          console.debug('[Deepthix][TerminalTab] shortcut font- ', { termId, next });
          onSettingsChangeRef.current({ terminalFontSize: next });
        }
        return;
      }
      if (ev.key === '0') {
        ev.preventDefault();
        console.debug('[Deepthix][TerminalTab] shortcut font reset', { termId });
        onSettingsChangeRef.current({ terminalFontSize: TERMINAL_DEFAULT_FONT_SIZE });
      }
    }
    el.addEventListener('keydown', onKeyDown);

    // Wheel scroll: claude code (and any TUI using mouse-tracking mode 1000+)
    // tells xterm to forward wheel events as escape codes to the application,
    // which means xterm's built-in viewport scrolling never fires. We catch
    // wheel events in the CAPTURE phase, scroll the buffer ourselves, and
    // preventDefault so xterm's mouse-mode handler doesn't also send them
    // downstream. ~3 lines per notch matches macOS terminal feel; deltaMode
    // === 1 (line) and deltaMode === 2 (page) are unusual but handled.
    function onWheel(ev: WheelEvent): void {
      if (!termRef.current) return;
      // deltaMode 0 = pixels, 1 = lines, 2 = pages
      let lines: number;
      if (ev.deltaMode === 1) {
        lines = ev.deltaY;
      } else if (ev.deltaMode === 2) {
        lines = ev.deltaY * (termRef.current.rows ?? 24);
      } else {
        // Pixels — divide by approximate row height. ~16px per row at 13px
        // font is close enough; the user feel is what matters, not precision.
        lines = ev.deltaY / 16;
      }
      // Round AWAY from zero so a tiny wheel nudge always moves at least 1
      // line (otherwise sub-row deltas silently no-op and the user assumes
      // scroll is broken).
      const rounded = lines >= 0 ? Math.ceil(lines) : Math.floor(lines);
      if (rounded === 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      termRef.current.scrollLines(rounded);
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });

    return () => {
      console.debug('[Deepthix][TerminalTab] unmount', { termId });
      clearInterval(autosaveTimer);
      // Final synchronous-ish save BEFORE we dispose xterm — once disposed
      // the serialize addon can't read the buffer anymore.
      const sid = sessionIdRef.current;
      const pid = projectIdRef.current;
      if (sid) {
        try {
          const content = serialize.serialize();
          console.info('[Deepthix][TerminalTab] saving scrollback on unmount', {
            termId,
            sessionId: sid,
            bytes: content.length,
          });
          void saveTerminalScrollback(pid, sid, content).catch((err) => {
            console.warn('[Deepthix][TerminalTab] unmount save failed', err);
          });
        } catch (err) {
          console.warn('[Deepthix][TerminalTab] unmount serialize failed', err);
        }
      }
      writeDisposable.dispose();
      unlisten?.();
      resizeObserver.disconnect();
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      term.dispose();
      serializeRef.current = null;
    };
    // termId is stable per-session; settings are intentionally NOT in deps
    // here — we don't want to tear down + re-create the xterm instance
    // every time the user hits +/-. Live updates run in the next effect.
    //
    // We intentionally exclude `projectId` and `sessionId` from deps too:
    // they're stable for the life of a terminal entry (claude resumes use
    // the same session id and live under the same project), and reading
    // them through refs lets the autosave timer + unmount handler always
    // see the current values without rebuilding the xterm instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  // Safe fit: xterm's FitAddon throws if called before the renderer has
  // initialized (visible-from-hidden race). Catch and retry a few times.
  const safeFit = useCallback((): void => {
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    const el = term.element;
    if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
    try {
      fit.fit();
      if (term.cols > 0 && term.rows > 0) {
        void ptyResize(termId, term.cols, term.rows);
        // Newer claude-code redraws when it sees a SIGWINCH; nudge the
        // canvas renderer too so any rows previously left blank past the
        // old fit height get repainted from the scrollback buffer.
        try {
          term.refresh(0, term.rows - 1);
        } catch (e) {
          console.debug('[Deepthix][TerminalTab] post-fit refresh failed', e);
        }
      }
    } catch (e) {
      console.debug('[Deepthix][TerminalTab] fit deferred', e);
    }
  }, [termId]);

  // Mirror the latest safeFit into the ref so the mount-time observer can
  // reach it without depending on it through React deps.
  useEffect(() => {
    safeFitRef.current = safeFit;
  }, [safeFit]);

  // Live-update the existing xterm instance when the global config changes
  // (settings pane controls or keyboard shortcuts). After mutating
  // term.options, call fit() so xterm recomputes char dims and resize the
  // pty so the shell sees the new geometry.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    console.debug('[Deepthix][TerminalTab] apply settings', {
      termId,
      fontSize: settings.terminalFontSize,
      fontFamily: settings.terminalFontFamily,
      lineHeight: settings.terminalLineHeight,
    });
    term.options.fontSize = settings.terminalFontSize;
    term.options.fontFamily = settings.terminalFontFamily;
    term.options.lineHeight = settings.terminalLineHeight;
    // xterm caches char metrics for the canvas renderer; force a refit + full
    // refresh so the new font/size actually paints. Without this, fontFamily
    // changes silently re-cache but keep using the old glyph atlas.
    requestAnimationFrame(() => {
      safeFit();
      try {
        term.refresh(0, term.rows - 1);
      } catch (e) {
        console.debug('[Deepthix][TerminalTab] refresh after settings change failed', e);
      }
    });
  }, [
    termId,
    settings.terminalFontSize,
    settings.terminalFontFamily,
    settings.terminalLineHeight,
    safeFit,
  ]);

  // When this tab becomes visible (display:none → block) OR when the
  // component just remounted (font change → key change), the ResizeObserver
  // doesn't always fire — the container's dimensions can stay 0 for a
  // tick, then jump straight to their final size without a "change" event
  // the observer cares about. Aggressive retries cover that gap: keep
  // calling safeFit until xterm reports valid cols, with a hard cap so
  // we don't spin forever on a hidden pane.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const tries = [16, 50, 120, 250, 500, 1000, 1800, 3000];
    const timers = tries.map((ms) =>
      setTimeout(() => {
        if (cancelled) return;
        const term = termRef.current;
        // Stop early if xterm already has a sane geometry — the rest of
        // the schedule is just safety net.
        if (term && term.cols >= 20 && term.rows >= 5) {
          // Still fit once more in case the container grew slightly; cheap.
          safeFit();
          return;
        }
        safeFit();
      }, ms),
    );
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [visible, safeFit, termId]);

  // Re-fit on every window resize (BottomPanel resize handle drags also fire it).
  useEffect(() => {
    function onWindowResize(): void {
      if (visible) safeFit();
    }
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, [visible, safeFit]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        display: visible ? 'block' : 'none',
        background: 'var(--color-bg)',
      }}
    />
  );
}
