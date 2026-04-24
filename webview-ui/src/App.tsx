import { useEffect, useRef, useState } from 'react';

import { BottomPanel } from './components/BottomPanel';
import { Sidebar } from './components/Sidebar';
import { TamagotchiView } from './components/TamagotchiView';
import { Welcome } from './components/Welcome';
import { useFileTree } from './hooks/useFileTree';
import { useProjects } from './hooks/useProjects';
import { useTerminals } from './hooks/useTerminals';
import { isTauriRuntime } from './runtime';
import { setActiveProjectId, setActiveProjectPath, setOnOpenTerminal } from './tauriApi';

function App(): React.JSX.Element {
  const projects = useProjects();
  const fileTree = useFileTree(projects.activeProject?.path ?? null);
  const terminals = useTerminals();

  console.log('[Deepthix][App] render', {
    projectsCount: projects.projects.length,
    activeProjectId: projects.activeProjectId,
    activeProjectPath: projects.activeProject?.path ?? null,
    terminalsCount: terminals.terminals.length,
  });

  // Keep the postMessage bridge in sync with the active project (used by
  // saveLayout — kept around in case future per-project state lands).
  useEffect(() => {
    setActiveProjectId(projects.activeProjectId);
  }, [projects.activeProjectId]);

  useEffect(() => {
    setActiveProjectPath(projects.activeProject?.path ?? null);
  }, [projects.activeProject?.path]);

  // The legacy `+ Agent` button (still wired in the BottomToolbar from
  // pixel-agents code) is gone; users now spawn agents via the Welcome
  // screen / inline button. Keep the bridge handler in case any leftover
  // postMessage call site still fires it, so it doesn't crash.
  useEffect(() => {
    setOnOpenTerminal((cwd, kind) => {
      const projectId = projects.activeProjectId;
      if (!projectId) {
        console.warn('[Deepthix][App] openTerminal dropped — no active project');
        return;
      }
      console.debug('[Deepthix][App] openTerminal handler invoked', { projectId, cwd, kind });
      void terminals.open(projectId, cwd, kind);
    });
    return () => setOnOpenTerminal(null);
  }, [terminals, projects.activeProjectId]);

  // The TamagotchiView reads agent activity from window message events. The
  // existing JSONL parser in useTerminals already dispatches those events.
  // No additional bridging needed for the per-project visualization.

  // On project switch, log + resume any persisted sessions for the new
  // project. resumeProject is idempotent (no-op if sessions already loaded).
  const lastActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const newId = projects.activeProjectId;
    if (lastActiveRef.current === newId) return;
    console.debug('[Deepthix][App] active project changed', {
      from: lastActiveRef.current,
      to: newId,
    });
    lastActiveRef.current = newId;
    if (newId) {
      void terminals.resumeProject(newId);
    }
  }, [projects.activeProjectId, projects.activeProject?.path, terminals]);

  // Tauri runtime indicator (compile-time presence check; logged once).
  useEffect(() => {
    console.log('[Deepthix][App] runtime', { isTauriRuntime });
  }, []);

  const hasProjects = projects.projects.length > 0;
  const visibleAgents = terminals.forProject(projects.activeProjectId);

  const SKIP_PERMS_KEY = 'deepthix.skipPermissions';
  const [skipPerms, setSkipPerms] = useState<boolean>(() => {
    return localStorage.getItem(SKIP_PERMS_KEY) === 'true';
  });
  useEffect(() => {
    localStorage.setItem(SKIP_PERMS_KEY, String(skipPerms));
  }, [skipPerms]);

  const onSpawnAgent = (): void => {
    const projectId = projects.activeProjectId;
    const cwd = projects.activeProject?.path;
    if (!projectId || !cwd) return;
    void terminals.open(projectId, cwd, 'claude', undefined, { skipPermissions: skipPerms });
  };

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        background: 'var(--color-bg)',
      }}
    >
      <Sidebar projects={projects} fileTree={fileTree} />
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {!hasProjects ? (
            <Welcome onOpenFolder={() => void projects.openAndAddProject()} />
          ) : (
            <>
              <TamagotchiView
                projectName={projects.activeProject?.name ?? null}
                terminals={visibleAgents}
              />
              <div
                style={{
                  position: 'absolute',
                  bottom: 24,
                  right: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-end',
                  gap: 8,
                  zIndex: 6,
                }}
              >
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: 'var(--color-bg-dark)',
                    border: '2px solid var(--color-border)',
                    boxShadow: 'var(--shadow-pixel)',
                    padding: '6px 10px',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: '11px',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  title="Pass --dangerously-skip-permissions to new sessions"
                >
                  <input
                    type="checkbox"
                    checked={skipPerms}
                    onChange={(e) => setSkipPerms(e.target.checked)}
                  />
                  skip perms
                </label>
                <button
                  type="button"
                  onClick={onSpawnAgent}
                  style={{
                    padding: '14px 24px',
                    background: 'var(--color-accent)',
                    color: 'var(--color-bg-dark)',
                    border: '2px solid var(--color-border)',
                    boxShadow: 'var(--shadow-pixel)',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: '16px',
                    cursor: 'pointer',
                  }}
                >
                  + Session
                </button>
              </div>
            </>
          )}
        </div>
        <BottomPanel
          terminals={terminals}
          projectId={projects.activeProjectId}
          projectPath={projects.activeProject?.path ?? null}
        />
      </div>
    </div>
  );
}

export default App;
