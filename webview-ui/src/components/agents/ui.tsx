// Shared building blocks + engine types for the ÉQUIPE and MISSIONS tabs.

import type { ReactNode } from 'react';

export function Card({ title, right, children }: { title?: ReactNode; right?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        border: '2px solid var(--color-border)',
        background: 'var(--color-bg-dark)',
        boxShadow: 'var(--shadow-pixel)',
        padding: 12,
        marginBottom: 12,
      }}
    >
      {(title || right) && (
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
          <div style={{ fontWeight: 700, color: 'var(--color-accent-bright)', flex: 1 }}>{title}</div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Btn({
  children,
  onClick,
  kind = 'normal',
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'normal' | 'primary' | 'danger' | 'success';
  disabled?: boolean;
  title?: string;
}): React.JSX.Element {
  const bg =
    kind === 'primary'
      ? 'var(--color-accent)'
      : kind === 'danger'
        ? 'var(--color-danger)'
        : kind === 'success'
          ? 'var(--color-status-success)'
          : 'var(--color-btn-bg)';
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        background: bg,
        color: kind === 'normal' ? 'var(--color-text)' : 'var(--color-on-accent)',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        fontFamily: 'var(--font-pixel)',
        fontSize: '0.8125rem',
        padding: '4px 10px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 'var(--btn-disabled-opacity)' : 1,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 8, alignItems: 'center', marginBottom: 6 }}>
      <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>{label}</span>
      {children}
    </label>
  );
}

export function Chip({ children, color }: { children: ReactNode; color?: string }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        border: `2px solid ${color ?? 'var(--color-border)'}`,
        color: color ?? 'var(--color-text)',
        padding: '1px 8px',
        margin: '2px 4px 2px 0',
        fontSize: '0.75rem',
      }}
    >
      {children}
    </span>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }): React.JSX.Element {
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-accent)',
        color: 'var(--color-on-accent)',
        border: '2px solid var(--color-border)',
        fontWeight: 700,
        fontSize: size > 40 ? '1.25rem' : '0.8125rem',
      }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
