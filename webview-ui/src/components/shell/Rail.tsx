// Left rail (design v2): one big button per space, role-aware, with a
// pulsing badge when decisions are waiting.

import type { SpaceId, SpaceMeta } from './spaces';

export function Rail({
  spaces,
  active,
  badges,
  onPick,
}: {
  spaces: SpaceMeta[];
  active: SpaceId;
  badges: Partial<Record<SpaceId, number>>;
  onPick: (id: SpaceId) => void;
}): React.JSX.Element {
  const item = (s: SpaceMeta): React.JSX.Element => {
    const on = s.id === active;
    const n = badges[s.id] ?? 0;
    return (
      <button
        key={s.id}
        type="button"
        title={s.title}
        onClick={() => onPick(s.id)}
        className="v2-hover-lift"
        style={{
          position: 'relative',
          width: 64,
          padding: '9px 0',
          borderRadius: 16,
          border: 'none',
          cursor: 'pointer',
          textAlign: 'center',
          color: on ? 'var(--color-text)' : 'var(--color-text-muted)',
          background: on ? 'var(--color-active-bg)' : 'transparent',
          boxShadow: on ? 'inset 0 0 0 1px var(--color-border)' : 'none',
          fontFamily: 'var(--font-pixel)',
        }}
      >
        <span style={{ fontSize: 22, display: 'block', lineHeight: 1.1 }}>{s.emoji}</span>
        <span style={{ fontSize: 10.5, fontWeight: 600 }}>{s.label}</span>
        {n > 0 && (
          <b
            style={{
              position: 'absolute',
              top: 2,
              right: 6,
              minWidth: 18,
              height: 18,
              borderRadius: 9,
              background: 'var(--color-warning)',
              color: 'var(--color-bg)',
              fontSize: 11,
              display: 'grid',
              placeItems: 'center',
              animation: 'v2-pulse 1.6s infinite',
            }}
          >
            {n}
          </b>
        )}
      </button>
    );
  };
  return (
    <nav
      style={{
        width: 82,
        flex: 'none',
        padding: '14px 0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        background: 'var(--color-sidebar-bg)',
        borderRight: '1px solid var(--color-border)',
        backdropFilter: 'blur(14px)',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 14,
          background: 'var(--gradient-accent)',
          display: 'grid',
          placeItems: 'center',
          fontWeight: 900,
          fontSize: 20,
          color: 'var(--color-on-accent)',
          marginBottom: 10,
        }}
      >
        E
      </div>
      {spaces.filter((s) => !s.bottom).map(item)}
      <div style={{ flex: 1 }} />
      {spaces.filter((s) => s.bottom).map(item)}
    </nav>
  );
}
