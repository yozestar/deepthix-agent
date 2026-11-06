// Who is looking at the app: the administrator (Johann, on the Mac mini)
// configures agents; collaborators (remote access) only see their work,
// their validations and "ask an agent". The UI split is convenience only:
// the server enforces it too (agents_collab vs agents_api, see agents.rs).

import { useCallback, useEffect, useState } from 'react';

import { isRemoteRuntime } from '../runtime';

export type Role = 'admin' | 'collab';
const PREVIEW_KEY = 'elyone.previewCollab';

export function useRole(): { role: Role; canPreview: boolean; preview: boolean; setPreview: (v: boolean) => void } {
  const base: Role = isRemoteRuntime ? 'collab' : 'admin';
  const [preview, setPreviewState] = useState<boolean>(() => localStorage.getItem(PREVIEW_KEY) === '1');
  useEffect(() => {
    localStorage.setItem(PREVIEW_KEY, preview ? '1' : '0');
  }, [preview]);
  const setPreview = useCallback((v: boolean) => setPreviewState(v), []);
  return { role: base === 'admin' && !preview ? 'admin' : 'collab', canPreview: base === 'admin', preview, setPreview };
}
