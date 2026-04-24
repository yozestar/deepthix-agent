import 'xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { useEffect, useRef } from 'react';
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

  useEffect(() => {
    if (visible && fitRef.current && termRef.current) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        if (termRef.current) {
          void ptyResize(termId, termRef.current.cols, termRef.current.rows);
        }
      });
    }
  }, [visible, termId]);

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
