import { useState } from 'react';

import type { Project } from '../tauri/types';

interface Props {
  projects: Project[];
  activeProjectId: string | null;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onOpenFolder: () => void;
}

export function ProjectList({
  projects,
  activeProjectId,
  onSwitch,
  onRemove,
  onRename,
  onOpenFolder,
}: Props): React.JSX.Element {
  // Inline rename state — mirrors the SessionsPane sub-tab rename pattern in
  // BottomPanel.tsx: double-click to enter edit mode, Enter saves, Escape
  // cancels, blur saves.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const commitRename = (id: string, original: string): void => {
    const trimmed = editingValue.trim();
    if (trimmed && trimmed !== original) {
      console.debug('[Deepthix][ProjectList] commit rename', { id, name: trimmed });
      onRename(id, trimmed);
    } else {
      console.debug('[Deepthix][ProjectList] rename no-op', { id });
    }
    setEditingId(null);
  };

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
          fontSize: '12px',
          opacity: 0.7,
          letterSpacing: '0.1em',
          padding: '4px',
        }}
      >
        PROJECTS
      </div>
      {projects.length === 0 && (
        <div style={{ fontSize: '13px', opacity: 0.6, padding: '4px' }}>
          No projects yet.
        </div>
      )}
      {projects.map((p) => {
        const isActive = p.id === activeProjectId;
        const isEditing = editingId === p.id;
        return (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => !isEditing && onSwitch(p.id)}
            onDoubleClick={() => {
              console.debug('[Deepthix][ProjectList] enter edit', { id: p.id });
              setEditingId(p.id);
              setEditingValue(p.name);
            }}
            onKeyDown={(e) => {
              if (isEditing) return;
              if (e.key === 'Enter' || e.key === ' ') onSwitch(p.id);
            }}
            style={{
              cursor: isEditing ? 'text' : 'pointer',
              padding: '4px 6px',
              background: isActive ? 'var(--color-accent)' : 'transparent',
              color: isActive ? 'var(--color-bg-dark)' : 'inherit',
              border: isActive ? '2px solid var(--color-border)' : '2px solid transparent',
              boxShadow: isActive ? 'var(--shadow-pixel)' : 'none',
              fontSize: '14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '6px',
            }}
            title={isEditing ? 'Editing name' : `${p.path}\n(double-click to rename)`}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden', flex: 1 }}>
              <span style={{ opacity: isActive ? 1 : 0 }}>●</span>
              {isEditing ? (
                <input
                  autoFocus
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => commitRename(p.id, p.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename(p.id, p.name);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingId(null);
                    }
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: '14px',
                    width: '100%',
                    outline: 'none',
                  }}
                />
              ) : (
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                </span>
              )}
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
          fontSize: '13px',
          fontFamily: 'var(--font-pixel)',
        }}
      >
        + Open Folder
      </button>
    </div>
  );
}
