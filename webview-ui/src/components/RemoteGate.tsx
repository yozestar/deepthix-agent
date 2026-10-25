// Remote mode only: holds the UI until this device is paired and connected,
// shows the pairing code, and remounts the app after every reconnect so each
// pane reloads what it missed while the phone was asleep or offline.

import { useEffect, useState } from 'react';

import { type RemoteClient, type RemoteState } from '../tauri/transport';

interface Props {
  client: RemoteClient;
  children: React.ReactNode;
}

export function RemoteGate({ client, children }: Props): React.JSX.Element {
  const [state, setState] = useState<RemoteState>(client.state());
  const [epoch, setEpoch] = useState(0);
  const [everReady, setEverReady] = useState(client.state().status === 'ready');

  useEffect(() => {
    const offState = client.subscribe((s) => {
      setState(s);
      if (s.status === 'ready') setEverReady(true);
    });
    const offResync = client.onResync(() => setEpoch((n) => n + 1));
    return () => {
      offState();
      offResync();
    };
  }, [client]);

  if (everReady && state.status !== 'denied') {
    return (
      <>
        {state.status !== 'ready' && (
          <div style={bannerStyle} role="status">
            Connexion perdue — reconnexion…
          </div>
        )}
        <div key={epoch} style={{ display: 'contents' }}>
          {children}
        </div>
      </>
    );
  }

  return (
    <div style={screenStyle}>
      <span style={{ fontSize: '1rem', letterSpacing: '0.08em' }}>ELYONE — ACCÈS À DISTANCE</span>
      {state.status === 'connecting' && <span>Connexion à ton agent…</span>}
      {state.status === 'offline' && (
        <span>Agent injoignable. Vérifie que le PC est allumé et l&apos;accès à distance activé.</span>
      )}
      {state.status === 'pairing' && (
        <>
          <span>Cet appareil n&apos;est pas encore autorisé.</span>
          <span>
            Code d&apos;appairage :{' '}
            <code style={{ fontSize: '1.5rem', letterSpacing: '0.2em' }}>{state.code}</code>
          </span>
          <span style={{ opacity: 0.7, fontSize: '0.8125rem' }}>
            Accepte la demande sur ton PC (ou sur un appareil déjà autorisé) en vérifiant ce code.
          </span>
        </>
      )}
      {state.status === 'denied' && (
        <>
          <span>Accès refusé ou appareil révoqué.</span>
          <button type="button" className="dt-btn dt-btn--primary" onClick={() => client.retry()}>
            Redemander l&apos;accès
          </button>
        </>
      )}
    </div>
  );
}

const screenStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 16,
  padding: 24,
  textAlign: 'center',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  fontFamily: 'var(--font-pixel)',
  fontSize: '0.9375rem',
  lineHeight: 1.5,
};

const bannerStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 400,
  padding: '6px 12px',
  textAlign: 'center',
  background: 'var(--color-warning)',
  color: 'var(--color-bg-dark)',
  fontFamily: 'var(--font-pixel)',
  fontSize: '0.8125rem',
};
