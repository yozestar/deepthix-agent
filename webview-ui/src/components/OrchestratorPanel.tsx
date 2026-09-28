// Side panel hosting the "orchestrator" — a single, always-available
// claude session that lives outside the project list and (later) gets
// MCP tools to read + act on every other session. Phase 1: just the
// terminal. Phase 2 will wire in the deepthix MCP server so the user
// can ask "summarize where the 3 sessions are at" and the chef will
// actually pull data from the other sessions' dashboards/transcripts.
//
// The orchestrator session is treated like any other claude session in
// useTerminals — same scrollback persistence, same status dot, same
// dashboard plumbing — but its `projectId` is the synthetic
// `__orchestrator__` so it never appears in the sidebar's project list
// or in OVERVIEW.

import { useEffect, useRef, useState } from 'react';

import type { GlobalConfig } from '../hooks/useGlobalConfig';
import type { UseTerminalsResult } from '../hooks/useTerminals';
import { TerminalTab } from './TerminalTab';

const ORCHESTRATOR_PROJECT_ID = '__orchestrator__';
// Resolved at first render via Tauri's path API so we don't bake a
// username into the bundle. Falls back to a sentinel for the SSR-ish
// initial paint; the real spawn happens after the resolution.
let resolvedOrchestratorCwd: string | null = null;
async function resolveOrchestratorCwd(): Promise<string> {
  if (resolvedOrchestratorCwd) return resolvedOrchestratorCwd;
  const { homeDir } = await import('@tauri-apps/api/path');
  const home = await homeDir();
  resolvedOrchestratorCwd = `${home.replace(/\/$/, '')}/.elyone/orchestrator`;
  return resolvedOrchestratorCwd;
}
const STORAGE_KEY_OPEN = 'deepthix.orchestrator.open';
const STORAGE_KEY_WIDTH = 'deepthix.orchestrator.width';
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 460;

interface Props {
  terminals: UseTerminalsResult;
  globalConfig: GlobalConfig;
  updateGlobalConfig: (partial: Partial<GlobalConfig>) => void;
}

export function OrchestratorPanel({
  terminals,
  globalConfig,
  updateGlobalConfig,
}: Props): React.JSX.Element | null {
  const [open, setOpen] = useState<boolean>(() => {
    return localStorage.getItem(STORAGE_KEY_OPEN) === 'true';
  });
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY_WIDTH));
    return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : DEFAULT_WIDTH;
  });
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_OPEN, String(open));
  }, [open]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_WIDTH, String(width));
  }, [width]);

  // Resize handle (mirrors Sidebar's pattern). Drag the LEFT edge of
  // the panel to grow/shrink it.
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWRef = useRef(0);
  useEffect(() => {
    function onMove(e: MouseEvent): void {
      if (!draggingRef.current) return;
      const dx = startXRef.current - e.clientX; // dragging left grows
      const next = Math.max(MIN_WIDTH, Math.min(window.innerWidth - 240, startWRef.current + dx));
      setWidth(next);
    }
    function onUp(): void {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWRef.current = width;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  };

  // Resume / spawn the orchestrator session lazily — only the FIRST
  // time the user opens the panel. Avoids an always-on claude process
  // for users who never use the chef.
  const sessions = terminals.forProject(ORCHESTRATOR_PROJECT_ID);
  const spawnAttemptedRef = useRef(false);
  useEffect(() => {
    if (!open || spawnAttemptedRef.current) return;
    spawnAttemptedRef.current = true;
    void (async (): Promise<void> => {
      const cwd = await resolveOrchestratorCwd();
      await terminals.resumeProject(ORCHESTRATOR_PROJECT_ID);
      // After resume, if there's still no session, spawn a fresh one.
      const stillEmpty = terminals.terminals.every(
        (t) => t.projectId !== ORCHESTRATOR_PROJECT_ID,
      );
      if (stillEmpty) {
        await terminals.open(ORCHESTRATOR_PROJECT_ID, cwd, 'claude', 'orchestrator', {
          skipPermissions: true,
        });
      }
    })();
  }, [open, terminals]);

  if (!open) {
    // Collapsed: just a thin vertical button on the right edge.
    return (
      <div
        style={{
          width: '32px',
          background: 'var(--color-bg-dark)',
          borderLeft: '2px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          cursor: 'pointer',
          fontFamily: 'var(--font-pixel)',
          fontSize: '0.6875rem',
          letterSpacing: '0.1em',
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          userSelect: 'none',
        }}
        onClick={() => setOpen(true)}
        title="Open the orchestrator"
      >
        CHEF ◀
      </div>
    );
  }

  const session = sessions[0] ?? null;

  return (
    <div style={{ display: 'flex', flexShrink: 0 }}>
      {/* Drag handle on the LEFT edge */}
      <div
        onMouseDown={onMouseDown}
        title="Drag to resize"
        style={{
          width: '6px',
          cursor: 'ew-resize',
          background: 'var(--color-border)',
          flexShrink: 0,
        }}
      />
      <div
        style={{
          width: `${width}px`,
          background: 'var(--color-bg)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-pixel)',
          flexShrink: 0,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            background: 'var(--color-bg-dark)',
            borderBottom: '2px solid var(--color-border)',
            minHeight: '40px',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.875rem', letterSpacing: '0.06em' }}>CHEF</span>
            <span style={{ fontSize: '0.625rem', opacity: 0.55 }}>orchestrator</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            title="Close panel"
            style={{
              background: 'transparent',
              color: 'inherit',
              border: '2px solid var(--color-border)',
              padding: '2px 8px',
              cursor: 'pointer',
              fontFamily: 'var(--font-pixel)',
              fontSize: '0.6875rem',
            }}
          >
            ▶ hide
          </button>
        </div>

        {/* Terminal */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {session ? (
            <TerminalTab
              key={`${session.id}::${globalConfig.terminalFontFamily}`}
              termId={session.id}
              visible={true}
              settings={globalConfig}
              onSettingsChange={updateGlobalConfig}
              projectId={session.projectId}
              sessionId={session.sessionId}
            />
          ) : (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: 0.55,
                fontSize: '0.8125rem',
              }}
            >
              spawning orchestrator…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
