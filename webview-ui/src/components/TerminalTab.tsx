import 'xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { useCallback, useEffect, useRef } from 'react';
import { Terminal } from 'xterm';

import { TERMINAL_DEFAULT_BG } from '../constants';
import { ptyResize, ptyWrite } from '../tauri/commands';
import { onPtyData, type PtyDataEvent } from '../tauri/events';

interface Props {
  termId: string;
  visible: boolean;
}

export function TerminalTab({ termId, visible }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      console.warn('[Deepthix][TerminalTab] no container ref', { termId });
      return;
    }
    console.debug('[Deepthix][TerminalTab] mount', { termId });
    // xterm renders to canvas → CSS vars don't resolve there. Read the
    // computed --color-bg from :root so the terminal background matches the
    // pixel-art palette without hardcoding the literal.
    const rootStyle = getComputedStyle(document.documentElement);
    const bgColor = rootStyle.getPropertyValue('--color-bg').trim() || TERMINAL_DEFAULT_BG;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'var(--font-pixel), Menlo, monospace',
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

    return () => {
      console.debug('[Deepthix][TerminalTab] unmount', { termId });
      writeDisposable.dispose();
      unlisten?.();
      resizeObserver.disconnect();
      term.dispose();
    };
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
