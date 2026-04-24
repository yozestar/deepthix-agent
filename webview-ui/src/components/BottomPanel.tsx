import { useCallback, useEffect, useRef, useState } from 'react';

import type { UseTerminalsResult } from '../hooks/useTerminals';

import { TerminalTab } from './TerminalTab';

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 300;
const STORAGE_KEY = 'deepthix.bottomPanelHeight';

interface Props {
  terminals: UseTerminalsResult;
}

export function BottomPanel({ terminals }: Props): React.JSX.Element | null {
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

  if (terminals.terminals.length === 0) return null;
  return (
    <div
      style={{
        height: `${height}px`,
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-pixel)',
        flexShrink: 0,
        position: 'relative',
      }}
    >
      <div
        onMouseDown={onMouseDown}
        title="Drag to resize"
        style={{
          height: '6px',
          cursor: 'ns-resize',
          background: 'var(--color-border)',
          borderTop: '1px solid var(--color-bg-dark)',
          borderBottom: '1px solid var(--color-bg-dark)',
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
        {terminals.terminals.map((t) => {
          const isActive = t.id === terminals.activeId;
          return (
            <button
              key={t.id}
              onClick={() => terminals.setActive(t.id)}
              style={{
                padding: '6px 12px',
                background: isActive ? 'var(--color-accent)' : 'transparent',
                color: isActive ? 'var(--color-bg-dark)' : 'inherit',
                border: '2px solid var(--color-border)',
                cursor: 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '11px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {t.label}
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
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {terminals.terminals.map((t) => (
          <div
            key={t.id}
            style={{
              position: 'absolute',
              inset: 0,
              display: t.id === terminals.activeId ? 'block' : 'none',
            }}
          >
            <TerminalTab termId={t.id} visible={t.id === terminals.activeId} />
          </div>
        ))}
      </div>
    </div>
  );
}
