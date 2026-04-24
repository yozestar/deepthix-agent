import { useCallback, useEffect, useRef, useState } from 'react';

import type { UseTerminalsResult } from '../hooks/useTerminals';
import { TerminalTab } from './TerminalTab';

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 300;
const STORAGE_KEY = 'deepthix.bottomPanelHeight';

interface Props {
  terminals: UseTerminalsResult;
  projectId: string | null;
}

export function BottomPanel({ terminals, projectId }: Props): React.JSX.Element | null {
  const visible = terminals.forProject(projectId);
  const effectiveActive: string | null = visible.some((t) => t.id === terminals.activeId)
    ? terminals.activeId
    : (visible[0]?.id ?? null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [height, setHeight] = useState<number>(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
  });
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHRef = useRef(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(height));
  }, [height]);

  const onMouseDown = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    draggingRef.current = true;
    startYRef.current = e.clientY;
    startHRef.current = height;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [height]);

  useEffect(() => {
    function onMove(e: MouseEvent): void {
      if (!draggingRef.current) return;
      const dy = startYRef.current - e.clientY;
      const next = Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 100, startHRef.current + dy));
      setHeight(next);
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

  // Always render so xterm instances stay alive across project switches.
  // The visible chrome (resize handle, tab bar) collapses when the current
  // project has no terminals; the off-project xterm instances live inside a
  // hidden tray to retain their scrollback / pty connection.
  const hasVisible = visible.length > 0;
  return (
    <div
      style={{
        height: hasVisible ? `${height}px` : 0,
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-pixel)',
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        onMouseDown={onMouseDown}
        title="Drag to resize"
        style={{
          height: hasVisible ? '6px' : 0,
          cursor: 'ns-resize',
          background: 'var(--color-border)',
          borderTop: hasVisible ? '1px solid var(--color-bg-dark)' : 'none',
          borderBottom: hasVisible ? '1px solid var(--color-bg-dark)' : 'none',
          flexShrink: 0,
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
          padding: '0 4px',
          gap: '2px',
          minHeight: '32px',
          flexShrink: 0,
        }}
      >
        {visible.map((t) => {
          const isActive = t.id === effectiveActive;
          const isEditing = editingId === t.id;
          return (
            <div
              key={t.id}
              onClick={() => !isEditing && terminals.setActive(t.id)}
              onDoubleClick={() => {
                setEditingId(t.id);
                setEditingValue(t.label);
              }}
              style={{
                padding: '6px 12px',
                background: isActive ? 'var(--color-accent)' : 'transparent',
                color: isActive ? 'var(--color-bg-dark)' : 'inherit',
                border: '2px solid var(--color-border)',
                cursor: isEditing ? 'text' : 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '11px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              title="Double-click to rename"
            >
              {isEditing ? (
                <input
                  autoFocus
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => {
                    terminals.rename(t.id, editingValue);
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      terminals.rename(t.id, editingValue);
                      setEditingId(null);
                    } else if (e.key === 'Escape') {
                      setEditingId(null);
                    }
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: '11px',
                    width: `${Math.max(60, editingValue.length * 8)}px`,
                    outline: 'none',
                  }}
                />
              ) : (
                <span>{t.label}</span>
              )}
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  void terminals.close(t.id);
                }}
                style={{ opacity: 0.7, padding: '0 2px' }}
                aria-label={`Close ${t.label}`}
              >
                ×
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Mount EVERY terminal across all projects so xterm instances retain
            their scrollback when the user switches projects. Only the active
            visible one is on-screen; off-project tabs and same-project
            inactive tabs are visually hidden but still receive pty_data. */}
        {terminals.terminals.map((t) => (
          <div
            key={t.id}
            style={{
              position: 'absolute',
              inset: 0,
              display: t.id === effectiveActive ? 'block' : 'none',
            }}
          >
            <TerminalTab termId={t.id} visible={t.id === effectiveActive} />
          </div>
        ))}
      </div>
    </div>
  );
}
