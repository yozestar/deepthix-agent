// Who is looking at the app, according to the team server (Mac mini):
// the engine answers `moi` with the user's profile from utilisateurs.json,
// based on the verified identity (owner of the Mac locally, Cloudflare
// Access email remotely). The server enforces the same rights on every action;
// this hook only decides which spaces to show.
//   admin        → everything
//   responsable  → home, projects, team (agents of their pole), missions, knowledge
//   collab       → home, projects, missions (their validations), ask an agent
//   local        → no team server reachable: local work only (projects, settings)

import { useCallback, useEffect, useState } from 'react';

import { agentsApi } from '../tauri/commands';

export type Role = 'admin' | 'responsable' | 'collab' | 'local';
export interface Me {
  email: string;
  nom?: string;
  profil: 'admin' | 'responsable' | 'collaborateur' | 'aucun';
  pole?: string;
  peut_demander?: string[];
  gere?: string[];
}
const PREVIEW_KEY = 'elyone.previewCollab';

export function useRole(): { role: Role; me: Me | null; canPreview: boolean; preview: boolean; setPreview: (v: boolean) => void } {
  const [me, setMe] = useState<Me | null>(null);
  const [reachable, setReachable] = useState(true);
  const [preview, setPreviewState] = useState<boolean>(() => localStorage.getItem(PREVIEW_KEY) === '1');
  useEffect(() => {
    localStorage.setItem(PREVIEW_KEY, preview ? '1' : '0');
  }, [preview]);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void agentsApi<Me>('moi')
        .then((m) => {
          if (!alive) return;
          setMe(m);
          setReachable(true);
        })
        .catch(() => alive && setReachable(false));
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const setPreview = useCallback((v: boolean) => setPreviewState(v), []);
  let base: Role = 'local';
  if (reachable && me) base = me.profil === 'admin' ? 'admin' : me.profil === 'responsable' ? 'responsable' : me.profil === 'collaborateur' ? 'collab' : 'local';
  const canPreview = base === 'admin';
  return { role: canPreview && preview ? 'collab' : base, me, canPreview, preview, setPreview };
}
