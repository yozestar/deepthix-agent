// Réglages → « Serveur d'équipe »: where a colleague's local app gets its rights
// and the agents (the Mac mini). Shows who he is for the server, the connection
// state (connecting / pairing code / connected), and a login button that opens
// the Microsoft (Cloudflare Access) login in the "Mac distant" window.

import { useEffect, useState } from 'react';

import { agentsApi, clientModeSet } from '../tauri/commands';
import { teamClient, teamServerUrl } from '../tauri/teamClient';
import type { RemoteState } from '../tauri/transport';

interface Me {
  email: string;
  nom?: string;
  profil: string;
  pole?: string;
}
const PROFILS: Record<string, string> = { admin: '👑 Administrateur', responsable: '🧭 Responsable de pôle', collaborateur: '🙂 Collaborateur', aucun: '— aucun droit' };

const box: React.CSSProperties = {
  background: 'var(--color-bg-dark)',
  border: '1px solid var(--color-border)',
  borderRadius: 18,
  padding: 16,
  margin: '0 0 16px',
  boxShadow: 'var(--shadow-pixel)',
  fontFamily: 'var(--font-pixel)',
  color: 'var(--color-text)',
};

export function TeamServerCard(): React.JSX.Element {
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState('');
  const [me, setMe] = useState<Me | null>(null);
  const [local, setLocal] = useState<boolean | null>(null);
  const [state, setState] = useState<RemoteState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void teamServerUrl().then((u) => {
      setUrl(u);
      setDraft(u);
    });
    void agentsApi<Me>('moi')
      .then((m) => {
        setMe(m);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Is the engine on this computer (Mac mini) or do we go through the team server?
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let alive = true;
    void (async () => {
      const tc = await teamClient();
      if (!alive || !tc) {
        setLocal(true);
        return;
      }
      setLocal(false);
      setState(tc.state());
      unsub = tc.subscribe((s) => {
        setState(s);
        if (s.status === 'ready') void agentsApi<Me>('moi').then(setMe).catch(() => undefined);
      });
    })();
    return () => {
      alive = false;
      unsub?.();
    };
  }, [url]);

  const connect = (): void => {
    void clientModeSet(draft.trim())
      .then(() => setUrl(draft.trim()))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const status = state?.status;
  return (
    <div style={box}>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>🏢 Serveur d'équipe</div>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', marginBottom: 12 }}>
        Tu travailles sur ce poste avec ta licence Claude. Tes droits et les agents viennent du Mac mini d'Elyone.
      </div>
      {me && me.profil !== 'aucun' ? (
        <div style={{ marginBottom: 10 }}>
          Connecté en tant que <b>{me.nom || me.email}</b> · {PROFILS[me.profil] ?? me.profil}
          {me.pole ? ` · ${me.pole}` : ''}
          {local && <span style={{ color: 'var(--color-text-muted)' }}> (ce poste est le Mac mini)</span>}
        </div>
      ) : me ? (
        <div style={{ marginBottom: 10, color: 'var(--color-warning)' }}>
          {me.email || 'Ton compte'} n'a pas encore de droits : demande à un administrateur de t'ajouter dans Équipe → Utilisateurs.
        </div>
      ) : null}
      {!local && (
        <div style={{ marginBottom: 10, fontSize: 13 }}>
          {status === 'ready' && <span style={{ color: 'var(--color-status-success)' }}>● Connecté au serveur d'équipe</span>}
          {status === 'connecting' && <span style={{ color: 'var(--color-text-muted)' }}>… connexion en cours</span>}
          {status === 'offline' && (
            <span style={{ color: 'var(--color-warning)' }}>○ Serveur injoignable ou connexion Microsoft à faire (bouton ci-dessous)</span>
          )}
          {status === 'pairing' && (
            <span style={{ color: 'var(--color-warning)' }}>
              🔐 Premier branchement : un administrateur doit accepter ce poste sur le Mac mini — code <b>{state?.code}</b>
            </span>
          )}
          {status === 'denied' && <span style={{ color: 'var(--color-danger)' }}>✕ Ce poste a été refusé par le Mac mini</span>}
        </div>
      )}
      {error && !me && local === false && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://adresse-du-mac-mini.elyone.com"
          style={{ flex: 1, background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '8px 10px', color: 'var(--color-text)' }}
        />
        <button
          type="button"
          disabled={!draft.trim()}
          onClick={connect}
          style={{ border: 'none', borderRadius: 12, padding: '8px 14px', fontWeight: 800, background: 'var(--gradient-accent)', color: 'var(--color-on-accent)', cursor: 'pointer' }}
        >
          Se connecter (compte Microsoft)
        </button>
      </div>
    </div>
  );
}
