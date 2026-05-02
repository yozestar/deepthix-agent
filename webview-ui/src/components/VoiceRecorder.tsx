/* eslint-disable deepthix/no-inline-colors */
// Push-to-talk voice → text injection. Hold Cmd+M to record, release
// to transcribe (local whisper.cpp) and stream the result into the
// active terminal as if you'd typed it.
//
// Visual states:
//   - idle:        nothing on screen
//   - recording:   red overlay "🎙 enregistrement…" + duration counter
//   - transcribing: orange overlay "transcrivant…"
//   - error:       red overlay with the error message (auto-dismiss 4s)
//
// macOS Cmd+M is the system "minimize window" shortcut; we
// preventDefault inside the webview so it doesn't fire while we hold
// the key. Outside the app the system shortcut still works normally.

import { useCallback, useEffect, useRef, useState } from 'react';

import { chatSendUserText, ptyWrite, transcribeAudio } from '../tauri/commands';

type RecorderState =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'transcribing' }
  | { kind: 'error'; message: string };

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
  /** All terminals (filtered down to the active project below). */
  terminals: TermSummary[];
  /** Currently visible project — we only inject into terminals here. */
  activeProjectId: string | null;
}

const HOTKEY_CODE = 'KeyM';
const MIN_DURATION_MS = 250; // ignore accidental taps

export function VoiceRecorder({
  activeTermId,
  terminals,
  activeProjectId,
}: Props): React.JSX.Element | null {
  const [state, setState] = useState<RecorderState>({ kind: 'idle' });
  // Tick state pulses in `recording` so the visible duration counter
  // updates without us calling Date.now() during render (React's
  // purity rule).
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (state.kind !== 'recording') return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [state.kind]);

  // Stable refs the keydown/keyup handlers can read without rebinding.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
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

  /**
   * Resolve the terminal we should ptyWrite the transcript into.
   *
   * Order of preference:
   *   1. The globally-active term, IF it's a claude session in the current
   *      project (the user's last click is the strongest intent signal).
   *   2. Any other claude session in the current project (single-session
   *      projects: this is unambiguous; multi-session: pick first).
   *   3. null → caller shows an "open / focus a claude session" error.
   *
   * `activeTermId` is global, so before this fix the voice could land in
   * a session for an unrelated project the user wasn't even looking at —
   * the bytes shipped, claude received them, but nothing visible to the
   * user happened.
   */
  function resolveTarget(): TermSummary | null {
    const projectId = activeProjectIdRef.current;
    const all = terminalsRef.current;
    if (!projectId) return null;
    const inProject = all.filter(
      (t) => t.projectId === projectId && t.kind === 'claude',
    );
    if (inProject.length === 0) return null;
    const active = inProject.find((t) => t.id === activeTermIdRef.current);
    return active ?? inProject[0];
  }

  // MediaRecorder + chunks live in refs so the keyup handler can stop
  // them without React re-renders messing with the lifecycle.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number>(0);

  // Auto-dismiss errors after 4s.
  useEffect(() => {
    if (state.kind !== 'error') return;
    const id = setTimeout(() => setState({ kind: 'idle' }), 4000);
    return () => clearTimeout(id);
  }, [state]);

  const stopAndTranscribe = useCallback(async (): Promise<void> => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (rec.state === 'inactive') return;
    const duration = Date.now() - startedAtRef.current;
    rec.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    if (duration < MIN_DURATION_MS) {
      // Tap too short — discard.
      console.debug('[Deepthix][VoiceRecorder] tap too short, discarding', { duration });
      setState({ kind: 'idle' });
      chunksRef.current = [];
      return;
    }

    // MediaRecorder.stop() is async — wait for the final dataavailable.
    await new Promise<void>((resolve) => {
      if (chunksRef.current.length > 0) {
        // Already drained.
        resolve();
        return;
      }
      const onStop = (): void => {
        rec.removeEventListener('stop', onStop);
        resolve();
      };
      rec.addEventListener('stop', onStop);
    });

    setState({ kind: 'transcribing' });

    try {
      const blob = new Blob(chunksRef.current, {
        type: rec.mimeType || 'audio/webm',
      });
      chunksRef.current = [];
      const buf = await blob.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      const result = await transcribeAudio(b64, rec.mimeType || null, 'fr');
      const text = result.text.trim();
      console.info('[Deepthix][VoiceRecorder] transcribed', {
        bytes: buf.byteLength,
        chars: text.length,
        elapsedMs: result.elapsed_ms,
      });
      if (!text) {
        console.info('[Deepthix][VoiceRecorder] empty transcript, nothing to inject');
        setState({ kind: 'idle' });
        return;
      }
      const targetTerm = resolveTarget();
      if (!targetTerm) {
        console.warn('[Deepthix][VoiceRecorder] no claude session in active project', {
          activeProjectId: activeProjectIdRef.current,
          activeTermId: activeTermIdRef.current,
          chars: text.length,
        });
        setState({
          kind: 'error',
          message: 'no claude session in this project — open one first',
        });
        return;
      }
      const target = targetTerm.id;
      console.info('[Deepthix][VoiceRecorder] V4 injecting char-by-char', {
        target,
        targetLabel: targetTerm.label,
        targetCwd: targetTerm.cwd,
        targetProjectId: targetTerm.projectId,
        wasGlobalActive: targetTerm.id === activeTermIdRef.current,
        chars: text.length,
        preview: text.slice(0, 60),
      });
      // Bracketed-paste (\x1b[200~ ... \x1b[201~) does NOT work with
      // claude code: its prompt is a custom Ink component using
      // `useInput`, and Ink's parseKeypress doesn't recognise paste
      // markers (only the new `usePaste` hook in Ink 7+ does, and
      // claude code doesn't use it). Markers got reported as a noisy
      // CSI keystroke and the payload was discarded.
      // The de-facto fix (same one tmux uses) is to send the raw
      // text in small chunks with a tiny gap so node-pty + Ink's
      // stdin loop process each chunk cleanly. Caps:
      //   - 64 bytes per chunk: well under the 1018-byte node-pty
      //     macOS truncation threshold (microsoft/node-pty#726).
      //   - 12 ms between chunks: empirically enough for Ink's input
      //     queue to drain without making short transcripts feel slow.
      // Still no trailing \n — user reads + submits manually.
      // v2 (64-byte chunks) didn't work: bytes reached the pty (visible
      // in tracing) but claude code's prompt stayed empty. Hypothesis:
      // Ink's stdin reader coalesces bursty multi-byte writes into a
      // single read, and the merged buffer doesn't match a known
      // keypress event so the chars get filtered out.
      // v3 (this) — write 1 character at a time with an 8 ms gap.
      // Mirrors what xterm.onData sends when the user types (single
      // chars), the only path we know works in this codebase. Slower
      // (~120 chars/sec) but reliable.
      try {
        if (targetTerm.kind === 'claude') {
          // Chat sessions go through stream-json, not PTY. Send the
          // whole transcript as one user turn — the multi-character
          // chunking trick was a PTY/Ink workaround.
          await chatSendUserText(target, text);
          // Tell ChatPane to add a user bubble + flip busy=true.
          // Without this the user sees no feedback that their voice
          // got injected — claude's response just appears out of
          // nowhere later.
          window.dispatchEvent(
            new CustomEvent('deepthix:chat:user-text', {
              detail: { termId: target, text },
            }),
          );
          console.info('[Deepthix][VoiceRecorder] chat send complete', {
            target,
            chars: text.length,
          });
        } else {
          const PER_CHAR_DELAY_MS = 8;
          // Array.from splits on Unicode code points, not UTF-16 code
          // units, so accents like é and emoji stay intact.
          const chars = Array.from(text);
          for (let i = 0; i < chars.length; i++) {
            await ptyWrite(target, chars[i]);
            if (i < chars.length - 1) {
              await new Promise((r) => setTimeout(r, PER_CHAR_DELAY_MS));
            }
          }
          console.info('[Deepthix][VoiceRecorder] V4 PTY injection complete', {
            target,
            chars: chars.length,
          });
        }
      } catch (writeErr) {
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        console.error('[Deepthix][VoiceRecorder] V4 ptyWrite failed', writeErr);
        setState({ kind: 'error', message: `pty write: ${msg}` });
        return;
      }
      setState({ kind: 'idle' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[Deepthix][VoiceRecorder] transcribe failed', e);
      setState({ kind: 'error', message: msg });
    }
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    if (stateRef.current.kind !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
      ];
      const supportedMime =
        mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'audio/webm';
      const rec = new MediaRecorder(stream, { mimeType: supportedMime });
      chunksRef.current = [];
      rec.addEventListener('dataavailable', (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      });
      rec.start();
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      setState({ kind: 'recording', startedAt: startedAtRef.current });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[Deepthix][VoiceRecorder] mic access failed', e);
      setState({ kind: 'error', message: `mic: ${msg}` });
    }
  }, []);

  // Global hotkey listeners. Cmd+M (no shift) push-to-talk.
  useEffect(() => {
    function isOurHotkey(ev: KeyboardEvent): boolean {
      // Only metaKey (Cmd on macOS), no shift/alt/ctrl.
      return ev.code === HOTKEY_CODE && ev.metaKey && !ev.shiftKey && !ev.altKey && !ev.ctrlKey;
    }
    function onKeyDown(ev: KeyboardEvent): void {
      if (!isOurHotkey(ev)) return;
      if (ev.repeat) {
        // Holding the key — the OS sends repeats; we already recording.
        ev.preventDefault();
        return;
      }
      ev.preventDefault();
      void startRecording();
    }
    function onKeyUp(ev: KeyboardEvent): void {
      // On keyup `metaKey` may have already been released; check the code only.
      if (ev.code !== HOTKEY_CODE) return;
      if (stateRef.current.kind !== 'recording') return;
      ev.preventDefault();
      void stopAndTranscribe();
    }
    // Bridge so on-screen mic buttons (e.g. the one in ChatPane next
    // to Send) can drive the same start/stop logic. They dispatch
    // `deepthix:voice:start` on mousedown, `deepthix:voice:stop` on
    // mouseup. Same effect as holding ⌘M without the user having to
    // remember the shortcut.
    function onCustomStart(): void {
      void startRecording();
    }
    function onCustomStop(): void {
      if (stateRef.current.kind !== 'recording') return;
      void stopAndTranscribe();
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('deepthix:voice:start', onCustomStart);
    window.addEventListener('deepthix:voice:stop', onCustomStop);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('deepthix:voice:start', onCustomStart);
      window.removeEventListener('deepthix:voice:stop', onCustomStop);
    };
  }, [startRecording, stopAndTranscribe]);

  if (state.kind === 'idle') return null;

  // Floating overlay center-bottom. Doesn't capture pointer events so
  // the user can keep clicking around even mid-record.
  let bg = 'var(--color-bg-dark)';
  let label = '';
  let icon = '';
  if (state.kind === 'recording') {
    bg = 'var(--color-danger)';
    icon = '🎙';
    const sec = Math.max(0, Math.floor((now - state.startedAt) / 1000));
    label = `enregistrement… ${sec}s — relâche ⌘M pour transcrire`;
  } else if (state.kind === 'transcribing') {
    bg = 'var(--color-warning, #f59e0b)';
    icon = '✦';
    label = 'transcrivant…';
  } else {
    bg = 'var(--color-danger)';
    icon = '✗';
    label = state.message;
  }
  return (
    <div
      className="dt-chat-msg"
      style={{
        position: 'fixed',
        bottom: '32px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: bg,
        color: 'var(--color-bg-dark)',
        padding: '10px 18px',
        border: '2px solid var(--color-border)',
        borderLeft: `4px solid ${state.kind === 'recording' ? 'var(--color-bg-dark)' : 'var(--color-bg-dark)'}`,
        boxShadow: 'var(--shadow-pixel)',
        fontFamily: 'var(--font-pixel)',
        fontSize: '13px',
        fontWeight: 'bold',
        letterSpacing: '0.04em',
        zIndex: 100,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        maxWidth: '80vw',
      }}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // Stream the buffer through small chunks to avoid blowing the
  // call-stack on long recordings (~2MB+).
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}
