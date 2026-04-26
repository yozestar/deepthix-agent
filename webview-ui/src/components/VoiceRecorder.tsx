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

import { ptyWrite, transcribeAudio } from '../tauri/commands';

type RecorderState =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'transcribing' }
  | { kind: 'error'; message: string };

interface Props {
  /** ID of the active terminal — what we ptyWrite the transcript into. */
  activeTermId: string | null;
}

const HOTKEY_CODE = 'KeyM';
const MIN_DURATION_MS = 250; // ignore accidental taps

export function VoiceRecorder({ activeTermId }: Props): React.JSX.Element | null {
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
      const target = activeTermIdRef.current;
      if (!text) {
        console.info('[Deepthix][VoiceRecorder] empty transcript, nothing to inject');
        setState({ kind: 'idle' });
        return;
      }
      if (!target) {
        console.warn('[Deepthix][VoiceRecorder] no activeTermId — refusing to inject', {
          chars: text.length,
        });
        setState({ kind: 'error', message: 'no active terminal — focus a session first' });
        return;
      }
      console.info('[Deepthix][VoiceRecorder] injecting transcript', {
        target,
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
      try {
        const CHUNK_SIZE = 64;
        const CHUNK_DELAY_MS = 12;
        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
          const chunk = text.slice(i, i + CHUNK_SIZE);
          await ptyWrite(target, chunk);
          if (i + CHUNK_SIZE < text.length) {
            await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
          }
        }
        console.info('[Deepthix][VoiceRecorder] injection complete', {
          target,
          chars: text.length,
        });
      } catch (writeErr) {
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        console.error('[Deepthix][VoiceRecorder] ptyWrite failed', writeErr);
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
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
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
      style={{
        position: 'fixed',
        bottom: '24px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: bg,
        color: 'var(--color-bg-dark)',
        padding: '8px 16px',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        fontFamily: 'var(--font-pixel)',
        fontSize: '13px',
        zIndex: 100,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
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
