import { useCallback, useEffect, useRef, useState } from 'react';

import type { UseProjectsResult } from '../hooks/useProjects';
import type { TerminalEntry } from '../hooks/useTerminals';
import { ConversationSidebar } from './ConversationSidebar';

const MIN_WIDTH = 240;
// Wider than the old projects-only column: rows now carry an avatar, a
// timestamp and a one-line preview. New storage key so the old 220px
// value doesn't squeeze the new layout.
const DEFAULT_WIDTH = 320;
const STORAGE_KEY = 'elyone.sidebarWidth';

interface Props {
  projects: UseProjectsResult;
  /** All terminals across every project — feeds the per-project status dot. */
  terminals: TerminalEntry[];
  /** Switches the right pane to the SettingsPane. */
  onOpenSettings: () => void;
  /** True when the parent's mode is `'settings'` (highlights the button). */
  settingsActive: boolean;
  /** Terminal entry id of the session shown in the chat area. */
  activeTermId: string | null;
  /** Open a session: switch project if needed, focus its chat. */
  onOpenSession: (projectId: string, termId: string) => void;
  /** Reopen a transcript found by content search that has no session entry. */
  onResumeSession: (projectId: string, sessionId: string) => void;
  /** New session in the active project. */
  onNewSession: () => void;
}

export function Sidebar({
  projects,
  terminals,
  onOpenSettings,
  settingsActive,
  activeTermId,
  onOpenSession,
  onResumeSession,
  onNewSession,
}: Props): React.JSX.Element {
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : DEFAULT_WIDTH;
  });
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWRef = useRef(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width));
  }, [width]);

  const onMouseDown = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWRef.current = width;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  useEffect(() => {
    function onMove(e: MouseEvent): void {
      if (!draggingRef.current) return;
      const dx = e.clientX - startXRef.current;
      const next = Math.max(MIN_WIDTH, Math.min(window.innerWidth - 200, startWRef.current + dx));
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

  return (
    <div style={{ display: 'flex', height: '100%', flexShrink: 0 }}>
      <div
        style={{
          width: `${width}px`,
          background: 'var(--color-sidebar-bg)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-pixel)',
          borderRight: '1px solid var(--color-sidebar-border)',
        }}
      >
        {/* Left sidebar is now PROJECTS-only per user request — the
            FileTree and Usage blocks moved to the top-menu tabs (FILES
            / USAGE) so the whole left column is the scrollable project
            switcher. */}
        <ConversationSidebar
          projects={projects.projects}
          activeProjectId={projects.activeProjectId}
          activeTermId={activeTermId}
          terminals={terminals}
          onSwitchProject={(id) => void projects.switchProject(id)}
          onOpenSession={onOpenSession}
          onResumeSession={onResumeSession}
          onRemoveProject={(id) => void projects.removeProject(id)}
          onRenameProject={(id, name) => void projects.renameProject(id, name)}
          onAddProject={() => void projects.openAndAddProject()}
          onNewSession={onNewSession}
          onOpenSettings={onOpenSettings}
          settingsActive={settingsActive}
        />
      </div>
      <div
        onMouseDown={onMouseDown}
        title="Drag to resize sidebar"
        style={{
          width: '4px',
          cursor: 'ew-resize',
          background: 'transparent',
          flexShrink: 0,
          transition: 'background 120ms ease',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.background = 'var(--color-accent)';
        }}
        onMouseLeave={(e) => {
          if (!draggingRef.current)
            (e.currentTarget as HTMLDivElement).style.background = 'transparent';
        }}
      />
    </div>
  );
}
