/* eslint-disable deepthix/no-inline-colors */
// File drag-and-drop → terminal injector.
//
// When the user drags a file (or several) into the Deepthix window, we
// catch Tauri's native drag-drop event and write the absolute file
// paths into the active claude session's pty. Claude code's TUI handles
// pasted paths in the prompt natively (it relativises them, treats
// them as @-mentions, etc.).
//
// Why a Tauri-native event and not browser DataTransfer:
//   - Browser drag-drop hands you File objects with no real `path` on
//     macOS (only the in-memory blob). Tauri's `onDragDropEvent` gives
//     us the actual filesystem path because the runtime layer sits
//     between the OS and the webview.
//   - Same drag-drop also lets us decline drops while showing a useful
//     hint instead of letting the OS open the file in another app.
//
// Component renders an overlay during a drag-over so the user sees a
// drop target appear; renders nothing in idle state.

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ptyWrite } from '../tauri/commands';

interface TermSummary {
  id: string;
  label: string;
  cwd: string;
  kind: string;
  projectId: string;
}

interface Props {
  /** Globally-active terminal id (last clicked across all projects). */
  activeTermId: string | null;
  /** All terminals — filtered to active project below. */
  terminals: TermSummary[];
  /** Currently visible project id — only inject into terminals here. */
  activeProjectId: string | null;
}

type DragState =
  | { kind: 'idle' }
  | { kind: 'over'; count: number }
  | { kind: 'error'; message: string };

export function TerminalDropTarget({
  activeTermId,
  terminals,
  activeProjectId,
}: Props): React.JSX.Element | null {
  const [state, setState] = useState<DragState>({ kind: 'idle' });

  const activeTermIdRef = useRef(activeTermId);
  useEffect(() => {
    activeTermIdRef.current = activeTermId;
  }, [activeTermId]);
  const terminalsRef = useRef(terminals);
  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);
  const activeProjectIdRef = useRef(activeProjectId);
  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  /** Same picker as VoiceRecorder — prefer the globally-active term IF
   *  it's a claude session in the current project, else first claude
   *  session in the project. */
  const resolveTarget = useCallback((): TermSummary | null => {
    const projectId = activeProjectIdRef.current;
    const all = terminalsRef.current;
    if (!projectId) return null;
    const inProject = all.filter(
      (t) => t.projectId === projectId && t.kind === 'claude',
    );
    if (inProject.length === 0) return null;
    const active = inProject.find((t) => t.id === activeTermIdRef.current);
    return active ?? inProject[0];
  }, []);

  // Auto-dismiss the error overlay after 4s, matching VoiceRecorder.
  useEffect(() => {
    if (state.kind !== 'error') return;
    const id = setTimeout(() => setState({ kind: 'idle' }), 4000);
    return () => clearTimeout(id);
  }, [state]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const win = getCurrentWebviewWindow();
    void win
      .onDragDropEvent((ev) => {
        const payload = ev.payload;
        if (payload.type === 'over') {
          // payload.paths is empty for the over phase on macOS — we
          // don't know the count yet. Show a generic "drop here" hint.
          setState((prev) => (prev.kind === 'error' ? prev : { kind: 'over', count: 0 }));
          return;
        }
        if (payload.type === 'leave') {
          setState((prev) => (prev.kind === 'over' ? { kind: 'idle' } : prev));
          return;
        }
        if (payload.type === 'drop') {
          const paths = payload.paths;
          if (!paths || paths.length === 0) {
            setState({ kind: 'error', message: 'no path in drop event' });
            return;
          }
          const target = resolveTarget();
          if (!target) {
            console.warn('[Deepthix][TerminalDropTarget] no claude session in active project', {
              activeProjectId: activeProjectIdRef.current,
              paths,
            });
            setState({
              kind: 'error',
              message: 'open a claude session in this project first',
            });
            return;
          }
          // Quote each path so spaces / special chars survive a paste
          // into the prompt. Single-quote wrap, escape any single quote
          // by closing-quoting-reopening (POSIX safe form: `'\''`).
          const quoted = paths.map(quoteForShell).join(' ');
          console.info('[Deepthix][TerminalDropTarget] dropping into pty', {
            target: target.id,
            targetLabel: target.label,
            count: paths.length,
            firstPath: paths[0],
          });
          // Reuse the voice recorder's char-by-char trick — Ink coalesces
          // bursty multi-byte writes and drops them. 8ms gap, 1 unicode
          // code point at a time. Trailing space (not \r) so the user
          // can edit / add context before submitting.
          void injectSlowly(target.id, `${quoted} `).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[Deepthix][TerminalDropTarget] inject failed', e);
            setState({ kind: 'error', message: `pty: ${msg}` });
          });
          setState({ kind: 'idle' });
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((err) => {
        console.error('[Deepthix][TerminalDropTarget] subscribe failed', err);
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [resolveTarget]);

  if (state.kind === 'idle') return null;

  const isError = state.kind === 'error';
  const label = isError
    ? state.message
    : state.kind === 'over' && state.count > 0
      ? `drop ${state.count} file${state.count > 1 ? 's' : ''} → active session`
      : 'drop file → active claude session';
  return (
    <div
      // Top overlay; doesn't capture pointer events so the underlying
      // drop target keeps receiving the OS-level drop.
      style={{
        position: 'fixed',
        top: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        background: isError ? 'var(--color-danger)' : 'var(--color-accent)',
        color: 'var(--color-bg-dark)',
        padding: '8px 16px',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        fontFamily: 'var(--font-pixel)',
        fontSize: '13px',
        zIndex: 200,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span>{isError ? '✗' : '⤓'}</span>
      <span>{label}</span>
    </div>
  );
}

/** POSIX shell-safe single-quoted form. */
function quoteForShell(p: string): string {
  if (p === '') return "''";
  // Escape any embedded single quote with the standard close-escape-open
  // pattern: ' becomes '\''
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/** Same char-by-char injection trick as VoiceRecorder — Ink's stdin
 *  reader coalesces bursty multi-byte writes and drops them, so we
 *  send one unicode code point per ptyWrite with an 8ms gap. */
async function injectSlowly(termId: string, text: string): Promise<void> {
  const PER_CHAR_DELAY_MS = 8;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    await ptyWrite(termId, chars[i]);
    if (i < chars.length - 1) {
      await new Promise((r) => setTimeout(r, PER_CHAR_DELAY_MS));
    }
  }
}
