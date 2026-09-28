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

import { ptyWrite, stashDroppedFile } from '../tauri/commands';

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

  /** Pick the best drop target. Order of preference:
   *    1. Globally-active term, if it's a claude session in this project
   *    2. First claude session in this project
   *    3. Any claude session anywhere (fallback so dropping after the
   *       project's session got idle-reaped still lands somewhere
   *       instead of showing "no claude session — open one first")
   */
  const resolveTarget = useCallback((): TermSummary | null => {
    const projectId = activeProjectIdRef.current;
    const all = terminalsRef.current;
    const inProject = projectId
      ? all.filter((t) => t.projectId === projectId && t.kind === 'claude')
      : [];
    if (inProject.length > 0) {
      const active = inProject.find((t) => t.id === activeTermIdRef.current);
      return active ?? inProject[0];
    }
    // Fallback: any claude session — better than dropping the file.
    const anyClaude = all.find((t) => t.kind === 'claude');
    return anyClaude ?? null;
  }, []);

  /** Image vs other-file split. Used to route to add-attachments (image
   *  preview thumbnail) vs append-input (path inserted into composer
   *  so the user can edit before sending — what they asked for). */
  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'svg']);
  const isImagePath = (p: string): boolean => {
    const dot = p.lastIndexOf('.');
    return dot >= 0 && IMAGE_EXTS.has(p.slice(dot + 1).toLowerCase());
  };

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
          // macOS's screenshot thumbnail (Cmd+Shift+4 → drag from
          // the floating preview) hands us a path inside
          // /var/folders/.../TemporaryItems/NSIRD_screencaptureui_*/
          // that the OS deletes the moment the drag ends. Claude reads
          // the file ~1s later and gets ENOENT. We stash every dropped
          // file into ~/.deepthix/dropped/ during the drop event (when
          // the file is still alive) so the path we hand to claude
          // survives. Cheap on stable paths too — single fs::copy.
          (async (): Promise<void> => {
            try {
              const stable = await Promise.all(
                paths.map((p) =>
                  stashDroppedFile(p).catch((err) => {
                    console.warn(
                      '[Deepthix][TerminalDropTarget] stash failed, falling back to original path',
                      { src: p, err },
                    );
                    return p; // fall back so the drop isn't a total loss
                  }),
                ),
              );
              console.info('[Deepthix][TerminalDropTarget] dropping into pty', {
                target: target.id,
                targetLabel: target.label,
                kind: target.kind,
                count: paths.length,
                firstSrc: paths[0],
                firstStable: stable[0],
              });
              if (target.kind === 'claude') {
                // Chat sessions: split images vs other files.
                //  - Images → stage as preview thumbnails (ChatPane
                //    listens for `deepthix:chat:add-attachments`).
                //  - Non-images → inject the QUOTED PATH into the
                //    composer textarea via `deepthix:chat:append-input`.
                //    That way claude sees `cat "/path/to/foo.csv"` style
                //    references and can `Read` them, and the user can
                //    add context around the path before sending.
                const images = stable.filter(isImagePath);
                const others = stable.filter((p) => !isImagePath(p));
                if (images.length > 0) {
                  window.dispatchEvent(
                    new CustomEvent('deepthix:chat:add-attachments', {
                      detail: { termId: target.id, paths: images },
                    }),
                  );
                }
                if (others.length > 0) {
                  // Quote each path so a space in the filename doesn't
                  // wreck claude's tool calls. Separator = space (single
                  // line) — user can wrap with newlines manually.
                  const text = others.map(quoteForShell).join(' ') + ' ';
                  window.dispatchEvent(
                    new CustomEvent('deepthix:chat:append-input', {
                      detail: { termId: target.id, text },
                    }),
                  );
                }
              } else {
                // Old PTY path — claude TUI / shell terminals know what
                // to do with a quoted path string.
                const quoted = stable.map(quoteForShell).join(' ');
                await injectSlowly(target.id, `${quoted} `);
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error('[Deepthix][TerminalDropTarget] drop pipeline failed', e);
              setState({ kind: 'error', message: `drop: ${msg}` });
            }
          })();
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
        color: 'var(--color-on-accent)',
        padding: '8px 16px',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        fontFamily: 'var(--font-pixel)',
        fontSize: '0.8125rem',
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
