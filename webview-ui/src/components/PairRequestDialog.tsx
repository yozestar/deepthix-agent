// Shown when a new device asks for remote access. The owner accepts or
// refuses here; a refused or expired request leaves the device locked out.

import { useEffect, useState } from 'react';

import { remotePairRespond } from '../tauri/commands';
import { onRemotePairRequest, type RemotePairRequest } from '../tauri/events';

export function PairRequestDialog(): React.JSX.Element | null {
  const [queue, setQueue] = useState<RemotePairRequest[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onRemotePairRequest((r) => setQueue((q) => [...q, r])).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const answer = async (accept: boolean): Promise<void> => {
    setError(null);
    try {
      await remotePairRespond(current.id, accept);
    } catch (e) {
      // Already answered elsewhere or expired: nothing left to decide.
      setError(String(e));
    }
    setQueue((q) => q.slice(1));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-backdrop)',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      <div
        style={{
          background: 'var(--color-bg)',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          width: 'min(420px, 92vw)',
        }}
      >
        <span style={{ fontSize: '0.875rem', letterSpacing: '0.08em' }}>ACCÈS À DISTANCE</span>
        <span style={{ fontSize: '0.8125rem', lineHeight: 1.5 }}>
          <strong>{current.name}</strong> demande à piloter cet agent à distance.
        </span>
        <span style={{ fontSize: '0.8125rem' }}>
          Vérifie que l&apos;appareil affiche le code{' '}
          <code style={{ fontSize: '1rem', letterSpacing: '0.15em' }}>{current.code}</code>
        </span>
        <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
          Si ce n&apos;est pas toi, refuse et coupe l&apos;accès à distance dans les réglages.
        </span>
        {error && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-danger)' }}>{error}</span>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="dt-btn" onClick={() => void answer(false)}>
            Refuser
          </button>
          <button
            type="button"
            className="dt-btn dt-btn--primary"
            onClick={() => void answer(true)}
          >
            Accepter
          </button>
        </div>
      </div>
    </div>
  );
}
