import type { UseTerminalsResult } from '../hooks/useTerminals';
import { TerminalTab } from './TerminalTab';

interface Props {
  terminals: UseTerminalsResult;
}

export function BottomPanel({ terminals }: Props): React.JSX.Element | null {
  if (terminals.terminals.length === 0) return null;
  return (
    <div
      style={{
        height: '300px',
        borderTop: '2px solid var(--color-border)',
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-pixel)',
        flexShrink: 0,
      }}
    >
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
