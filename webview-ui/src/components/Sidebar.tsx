import { useCallback, useEffect, useRef, useState } from 'react';

import type { UseFileTreeResult } from '../hooks/useFileTree';
import type { UseProjectsResult } from '../hooks/useProjects';
import { FileTree } from './FileTree';
import { ProjectList } from './ProjectList';

const MIN_WIDTH = 160;
const DEFAULT_WIDTH = 220;
const STORAGE_KEY = 'deepthix.sidebarWidth';

interface Props {
  projects: UseProjectsResult;
  fileTree: UseFileTreeResult;
  /**
   * Optional. Forwarded to the FileTree: clicking a file in the sidebar tree
   * fires this callback. App.tsx uses it to switch to Files mode and open
   * the file as a sub-tab.
   */
  onFileClick?: (path: string) => void;
}

export function Sidebar({ projects, fileTree, onFileClick }: Props): React.JSX.Element {
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
          background: 'var(--color-bg)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-pixel)',
        }}
      >
        <ProjectList
          projects={projects.projects}
          activeProjectId={projects.activeProjectId}
          onSwitch={(id) => void projects.switchProject(id)}
          onRemove={(id) => void projects.removeProject(id)}
          onRename={(id, name) => void projects.renameProject(id, name)}
          onOpenFolder={() => void projects.openAndAddProject()}
        />
        <div
          style={{
            height: '2px',
            background: 'var(--color-border)',
            margin: '0',
          }}
        />
        <FileTree tree={fileTree} onFileClick={onFileClick} />
      </div>
      <div
        onMouseDown={onMouseDown}
        title="Drag to resize sidebar"
        style={{
          width: '6px',
          cursor: 'ew-resize',
          background: 'var(--color-border)',
          flexShrink: 0,
        }}
      />
    </div>
  );
}
