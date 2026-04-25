import 'xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { useCallback, useEffect, useRef } from 'react';
import { Terminal } from 'xterm';

import {
  TERMINAL_DEFAULT_BG,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from '../constants';
import type { TerminalSettings } from '../hooks/useTerminals';
import { ptyResize, ptyWrite } from '../tauri/commands';
import { onPtyData, type PtyDataEvent } from '../tauri/events';

interface Props {
  termId: string;
  visible: boolean;
  /** Per-session font / line-height settings (Phase 10). */
  settings: TerminalSettings;
  /**
   * Called when the user changes settings *from inside the terminal*
   * (Cmd+=/Cmd+-/Cmd+0 keyboard shortcuts). The parent persists the new
   * value into `useTerminals.updateSettings`, which flows back into our
   * `settings` prop and triggers the live-update effect.
   */
  onSettingsChange: (partial: Partial<TerminalSettings>) => void;
}

function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return TERMINAL_DEFAULT_FONT_SIZE;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(n)));
}

export function TerminalTab({
  termId,
  visible,
  settings,
  onSettingsChange,
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Stash the latest settings + onSettingsChange so the keydown handler
  // (registered once at mount) always sees the current values without
  // having to re-bind every render.
  const settingsRef = useRef<TerminalSettings>(settings);
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
      fontSize: settingsRef.current.fontSize,
      fontFamily: settingsRef.current.fontFamily,
      lineHeight: settingsRef.current.lineHeight,
    });
    // xterm renders to canvas → CSS vars don't resolve there. Read the
    // computed --color-bg from :root so the terminal background matches the
    // pixel-art palette without hardcoding the literal.
    const rootStyle = getComputedStyle(document.documentElement);
    const bgColor = rootStyle.getPropertyValue('--color-bg').trim() || TERMINAL_DEFAULT_BG;
    const term = new Terminal({
      fontSize: settingsRef.current.fontSize,
      fontFamily: settingsRef.current.fontFamily,
      lineHeight: settingsRef.current.lineHeight,
      theme: { background: bgColor },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const writeDisposable = term.onData((data) => {
      void ptyWrite(termId, data);
    });

    let unlisten: (() => void) | null = null;
    void onPtyData((e: PtyDataEvent) => {
      if (e.id === termId) term.write(e.data);
    }).then((fn) => {
      unlisten = fn;
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      void ptyResize(termId, termRef.current.cols, termRef.current.rows);
    });
    resizeObserver.observe(el);

    // Per-session keyboard shortcuts. Only fire when xterm has focus —
    // xterm puts focus on the .xterm-helper-textarea (a hidden textarea
    // it owns), so we attach to the container and check `el.contains(target)`.
    // This keeps Cmd+= / Cmd+- / Cmd+0 from hijacking other inputs (e.g.
    // the SessionsPane rename textbox or any sidebar search).
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
        const next = clampFontSize(settingsRef.current.fontSize + 1);
        if (next !== settingsRef.current.fontSize) {
          console.debug('[Deepthix][TerminalTab] shortcut font+ ', { termId, next });
          onSettingsChangeRef.current({ fontSize: next });
        }
        return;
      }
      if (ev.key === '-') {
        ev.preventDefault();
        const next = clampFontSize(settingsRef.current.fontSize - 1);
        if (next !== settingsRef.current.fontSize) {
          console.debug('[Deepthix][TerminalTab] shortcut font- ', { termId, next });
          onSettingsChangeRef.current({ fontSize: next });
        }
        return;
      }
      if (ev.key === '0') {
        ev.preventDefault();
        console.debug('[Deepthix][TerminalTab] shortcut font reset', { termId });
        onSettingsChangeRef.current({ fontSize: TERMINAL_DEFAULT_FONT_SIZE });
      }
    }
    el.addEventListener('keydown', onKeyDown);

    return () => {
      console.debug('[Deepthix][TerminalTab] unmount', { termId });
      writeDisposable.dispose();
      unlisten?.();
      resizeObserver.disconnect();
      el.removeEventListener('keydown', onKeyDown);
      term.dispose();
    };
    // termId is stable per-session; settings are intentionally NOT in deps
    // here — we don't want to tear down + re-create the xterm instance
    // every time the user hits +/-. Live updates run in the next effect.
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
      }
    } catch (e) {
      console.debug('[Deepthix][TerminalTab] fit deferred', e);
    }
  }, [termId]);

  // Live-update the existing xterm instance when the user changes settings
  // (toolbar buttons or keyboard shortcuts). After mutating term.options,
  // call fit() so xterm recomputes char dims and resize the pty so the
  // shell sees the new geometry.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    console.debug('[Deepthix][TerminalTab] apply settings', {
      termId,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      lineHeight: settings.lineHeight,
    });
    term.options.fontSize = settings.fontSize;
    term.options.fontFamily = settings.fontFamily;
    term.options.lineHeight = settings.lineHeight;
    safeFit();
  }, [termId, settings.fontSize, settings.fontFamily, settings.lineHeight, safeFit]);

  // When this tab becomes visible (display:none → block), the ResizeObserver
  // might not fire. Run a few delayed fits so the xterm dims reflect the
  // laid-out container, and sync the new size back to the pty.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const tries = [50, 150, 400];
    const timers = tries.map((ms) =>
      setTimeout(() => {
        if (!cancelled) safeFit();
      }, ms),
    );
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [visible, safeFit]);

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
