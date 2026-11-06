/* eslint-disable react-refresh/only-export-components */
// Dev-only preview of the design v2 shell (rail + space header + agent panes)
// in a plain browser. Tauri's invoke is replaced by a local read-only bridge
// to the agent engine (127.0.0.1:8765). Not part of the app build.
import '../index.css';

import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { EquipePane } from '../components/agents/EquipePane';
import { HomePane } from '../components/agents/HomePane';
import { MissionsPane } from '../components/agents/MissionsPane';
import { SavoirPane } from '../components/agents/SavoirPane';
import { Rail } from '../components/shell/Rail';
import { SpaceHeader } from '../components/shell/SpaceHeader';
import { spaceOf, spacesFor } from '../components/shell/spaces';
import type { Mode } from '../components/TopTabs';
import { applyTheme } from '../themes';

interface Bridge {
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
}
(window as unknown as { __TAURI_INTERNALS__: Bridge }).__TAURI_INTERNALS__ = {
  invoke: async (_cmd, args) => {
    const r = await fetch('http://127.0.0.1:8765/', { method: 'POST', body: JSON.stringify(args) });
    return r.text();
  },
};
applyTheme('elyone-vivant');
document.documentElement.setAttribute('data-box-style', 'vivant');
document.documentElement.style.setProperty('--font-pixel', "'Inter', sans-serif");

const q = new URLSearchParams(location.search);

function Shell(): React.JSX.Element {
  const role = q.get('role') === 'collab' ? 'collab' : 'admin';
  const [mode, setMode] = useState<Mode>((q.get('mode') as Mode) ?? 'accueil');
  const space = spaceOf(mode);
  const spaces = spacesFor(role);
  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--app-backdrop)', color: 'var(--color-text)' }}>
      <Rail spaces={spaces} active={space.id} badges={{ missions: 2 }} onPick={(id) => setMode(spaces.find((s) => s.id === id)?.modes[0] ?? 'accueil')} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <SpaceHeader space={space} mode={mode} projectName="claude_agent" onMode={setMode} canPreview={role === 'admin'} preview={false} onPreview={() => undefined} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {mode === 'accueil' && <HomePane role={role} onGo={setMode} />}
          {mode === 'equipe' && <EquipePane />}
          {mode === 'missions' && <MissionsPane />}
          {mode === 'savoir' && <SavoirPane />}
        </div>
      </div>
    </div>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Shell />);
