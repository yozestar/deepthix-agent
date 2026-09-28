// Auto-update banner. On app mount, silently checks the configured
// updater endpoint (tauri.conf.json → plugins.updater.endpoints) for a
// newer version. If one is found, shows a non-intrusive banner pinned
// to the top of the window with "Install + restart" / "Later" actions.
//
// User flow:
//   - Silent check on mount → if no update, banner stays hidden forever
//   - If update found, banner appears at the top of the app
//   - "Install + restart" downloads + verifies the signature against the
//     pubkey embedded in the built app, applies the update in-place,
//     then relaunches via tauri-plugin-process
//   - "Later" hides the banner for this session (re-shown on next launch)
//
// Errors during check (no network, malformed JSON, missing signature)
// are logged and swallowed — the banner stays hidden so we never paint
// a "your app is broken" message at people who just opened Deepthix.

import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useCallback, useEffect, useState } from 'react';

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; update: Update }
  | { kind: 'downloading'; downloaded: number; total: number | null }
  | { kind: 'installed' }
  | { kind: 'error'; message: string };

export function UpdaterBanner(): React.JSX.Element | null {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [hidden, setHidden] = useState(false);

  // Auto-check on mount. Wrapped in a tiny delay so the first paint
  // isn't blocked by the network round-trip.
  useEffect(() => {
    const t = setTimeout(() => {
      void runCheck(false);
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCheck = useCallback(async (manual: boolean): Promise<void> => {
    setPhase({ kind: 'checking' });
    try {
      const upd = await check();
      if (upd) {
        console.info('[Deepthix][Updater] update available', {
          version: upd.version,
          date: upd.date,
        });
        setPhase({ kind: 'available', update: upd });
        setHidden(false);
      } else {
        console.debug('[Deepthix][Updater] up-to-date');
        if (manual) {
          // Briefly show "no update" only when the user explicitly
          // clicked Check; the auto-check stays silent.
          setPhase({ kind: 'installed' }); // re-use "done" copy
          setTimeout(() => setPhase({ kind: 'idle' }), 3000);
        } else {
          setPhase({ kind: 'idle' });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[Deepthix][Updater] check failed', e);
      // "None of the fallback platforms ... were found" fires every time
      // the repo ships unsigned artifacts (signing key not configured).
      // Silent here — the Settings → UPDATES section explains it; we
      // don't paint a scary banner across the top of the app.
      if (/none of the fallback platforms/i.test(msg) || /platforms.*were found/i.test(msg)) {
        setPhase({ kind: 'idle' });
        return;
      }
      if (manual) setPhase({ kind: 'error', message: msg });
      else setPhase({ kind: 'idle' });
    }
  }, []);

  const installAndRestart = useCallback(async (): Promise<void> => {
    if (phase.kind !== 'available') return;
    const upd = phase.update;
    setPhase({ kind: 'downloading', downloaded: 0, total: null });
    try {
      let downloaded = 0;
      let contentLength: number | null = null;
      await upd.downloadAndInstall((event) => {
        // Tauri 2 event shapes: { event: 'Started', data: { contentLength } }
        // | { event: 'Progress', data: { chunkLength } }
        // | { event: 'Finished' }
        if (event.event === 'Started') {
          contentLength = event.data.contentLength ?? null;
          setPhase({ kind: 'downloading', downloaded: 0, total: contentLength });
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          setPhase({ kind: 'downloading', downloaded, total: contentLength });
        } else if (event.event === 'Finished') {
          setPhase({ kind: 'installed' });
        }
      });
      // Give the user a beat to see "installed" before the relaunch.
      setTimeout(() => {
        void relaunch().catch((e) =>
          console.warn('[Deepthix][Updater] relaunch failed', e),
        );
      }, 600);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[Deepthix][Updater] install failed', e);
      setPhase({ kind: 'error', message: msg });
    }
  }, [phase]);

  // Expose check() to other panes via a global (for the SettingsPane
  // "Check for updates" button). Lightweight and avoids prop-drilling.
  useEffect(() => {
    const handler = (): void => {
      void runCheck(true);
      setHidden(false);
    };
    window.addEventListener('deepthix:updater:check', handler);
    return () => window.removeEventListener('deepthix:updater:check', handler);
  }, [runCheck]);

  if (hidden) return null;
  if (phase.kind === 'idle' || phase.kind === 'checking') return null;

  // Visual: a thin pinned banner across the top of the window.
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        background: 'var(--color-accent)',
        color: 'var(--color-bg-dark)',
        padding: '6px 12px',
        fontFamily: 'var(--font-pixel)',
        fontSize: '0.75rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        zIndex: 200,
        boxShadow: '0 2px 0 var(--color-border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {phase.kind === 'available' && (
          <span>
            ⬆ Update available: <strong>v{phase.update.version}</strong>
          </span>
        )}
        {phase.kind === 'downloading' && (
          <span>
            ⬇ Downloading
            {phase.total
              ? ` ${Math.round((phase.downloaded / phase.total) * 100)}%`
              : `… ${formatBytes(phase.downloaded)}`}
          </span>
        )}
        {phase.kind === 'installed' && <span>✓ Installed — relaunching…</span>}
        {phase.kind === 'error' && <span>Update error: {phase.message}</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {phase.kind === 'available' && (
          <>
            <button type="button" onClick={() => void installAndRestart()} style={btnStyle}>
              Install + restart
            </button>
            <button type="button" onClick={() => setHidden(true)} style={btnStyle}>
              Later
            </button>
          </>
        )}
        {phase.kind === 'error' && (
          <button type="button" onClick={() => setHidden(true)} style={btnStyle}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  all: 'unset',
  background: 'var(--color-bg-dark)',
  color: 'var(--color-accent)',
  border: '1px solid var(--color-bg-dark)',
  padding: '2px 10px',
  fontFamily: 'var(--font-pixel)',
  fontSize: '0.6875rem',
  cursor: 'pointer',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
