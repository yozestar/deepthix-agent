import type { Project } from '../tauri/types';

interface Props {
  projects: Project[];
  activeProjectId: string | null;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
  onOpenFolder: () => void;
}

export function ProjectList({
  projects,
  activeProjectId,
  onSwitch,
  onRemove,
  onOpenFolder,
}: Props): React.JSX.Element {
  return (
    <div
      className="project-list"
      style={{
        background: 'var(--color-bg)',
        borderRight: '2px solid var(--color-border)',
        padding: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      <div
        style={{
          fontSize: '10px',
          opacity: 0.7,
          letterSpacing: '0.1em',
          padding: '4px',
        }}
      >
        PROJECTS
      </div>
      {projects.length === 0 && (
        <div style={{ fontSize: '11px', opacity: 0.6, padding: '4px' }}>
          No projects yet.
        </div>
      )}
      {projects.map((p) => {
        const isActive = p.id === activeProjectId;
        return (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => onSwitch(p.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSwitch(p.id);
            }}
            style={{
              cursor: 'pointer',
              padding: '4px 6px',
              background: isActive ? 'var(--color-accent)' : 'transparent',
              color: isActive ? 'var(--color-bg-dark)' : 'inherit',
              border: isActive ? '2px solid var(--color-border)' : '2px solid transparent',
              boxShadow: isActive ? 'var(--shadow-pixel)' : 'none',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '6px',
            }}
            title={p.path}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden' }}>
              <span style={{ opacity: isActive ? 1 : 0 }}>●</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(p.id);
              }}
              aria-label={`Remove ${p.name}`}
              style={{
                background: 'transparent',
                color: 'inherit',
                border: 'none',
                cursor: 'pointer',
                opacity: 0.6,
                padding: '0 4px',
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onOpenFolder}
        style={{
          marginTop: '6px',
          padding: '6px 8px',
          background: 'transparent',
          color: 'inherit',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          cursor: 'pointer',
          fontSize: '11px',
          fontFamily: 'var(--font-pixel)',
        }}
      >
        + Open Folder
      </button>
    </div>
  );
}
