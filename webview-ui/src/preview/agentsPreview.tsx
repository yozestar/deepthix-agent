// Dev-only preview of the ÉQUIPE / MISSIONS tabs in a plain browser.
// Tauri's invoke is replaced by a call to a local bridge that runs the agent
// engine API (scripts: /tmp bridge on 127.0.0.1:8765). Not part of the app build.
import '../index.css';

import { createRoot } from 'react-dom/client';

import { EquipePane, type View } from '../components/agents/EquipePane';
import { MissionsPane } from '../components/agents/MissionsPane';

interface Bridge {
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
}
(window as unknown as { __TAURI_INTERNALS__: Bridge }).__TAURI_INTERNALS__ = {
  invoke: async (_cmd, args) => {
    const r = await fetch('http://127.0.0.1:8765/', { method: 'POST', body: JSON.stringify(args) });
    return r.text();
  },
};
const q = new URLSearchParams(location.search);
const tab = q.get('tab') ?? 'equipe';
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(tab === 'missions' ? <MissionsPane /> : <EquipePane initialView={(q.get('view') as View) ?? 'organigramme'} />);
}
