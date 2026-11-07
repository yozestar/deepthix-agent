// Header of the current space (design v2): breadcrumb-like title, subtitle,
// the space's own sub-tabs, and — for the administrator — a switch to preview
// the collaborator view. On touch layouts a menu button opens the drawer.

import type { Mode } from '../TopTabs';
import { MODE_LABELS, type SpaceMeta } from './spaces';

export function SpaceHeader({
  space,
  mode,
  projectName,
  onMode,
  canPreview,
  preview,
  onPreview,
  onOpenMenu,
}: {
  space: SpaceMeta;
  mode: Mode;
  projectName: string | null;
  onMode: (m: Mode) => void;
  canPreview: boolean;
  preview: boolean;
  onPreview: (v: boolean) => void;
  onOpenMenu?: () => void;
}): React.JSX.Element {
  const title = space.id === 'projets' && projectName ? projectName : space.title;
  const subtitle = space.id === 'projets' && projectName ? 'Projet ouvert' : space.subtitle;
  return (
    <div className="dt-hide-when-keyboard" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 22px 10px', flexWrap: 'wrap' }}>
      {onOpenMenu && (
        <button
          type="button"
          onClick={onOpenMenu}
          style={{ border: 'none', background: 'var(--color-btn-bg)', color: 'var(--color-text)', borderRadius: 10, padding: '6px 10px', cursor: 'pointer' }}
        >
          ☰
        </button>
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: -0.3, fontFamily: 'var(--font-pixel)', color: 'var(--color-text)' }}>
          {space.emoji} {title}
        </div>
        {subtitle && <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', fontFamily: 'var(--font-pixel)' }}>{subtitle}</div>}
      </div>
      {space.modes.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginLeft: 12, background: 'var(--color-btn-bg)', padding: 4, borderRadius: 999 }}>
          {space.modes.map((m) => {
            const on = m === mode;
            return (
              <button
                key={m}
                type="button"
                onClick={() => onMode(m)}
                style={{
                  border: 'none',
                  cursor: 'pointer',
                  borderRadius: 999,
                  padding: '6px 14px',
                  fontSize: 12.5,
                  fontWeight: 600,
                  fontFamily: 'var(--font-pixel)',
                  background: on ? 'var(--gradient-accent)' : 'transparent',
                  color: on ? 'var(--color-on-accent)' : 'var(--color-text-muted)',
                }}
              >
                {MODE_LABELS[m] ?? m}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ flex: 1 }} />
      {canPreview && (
        <button
          type="button"
          onClick={() => onPreview(!preview)}
          title="Voir l'app comme un collaborateur (sans la configuration des agents)"
          style={{
            border: '1px solid var(--color-border)',
            cursor: 'pointer',
            borderRadius: 999,
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'var(--font-pixel)',
            background: preview ? 'var(--gradient-warm)' : 'transparent',
            color: preview ? 'var(--color-on-accent)' : 'var(--color-text-muted)',
          }}
        >
          {preview ? '🙂 Aperçu collaborateur — revenir' : '👑 Administrateur'}
        </button>
      )}
    </div>
  );
}
