// Remote mode replacement for the native "choose a folder" dialog: browses
// the PC's folders through listDir. Mounted once; opened by openFolder().

import { useCallback, useEffect, useState } from 'react';

import { parentPath, subscribeFolderPick } from '../remote/folderPicker';
import { homeDir, listDir } from '../tauri/commands';
import type { FileEntry } from '../tauri/types';

export function RemoteFolderPicker(): React.JSX.Element | null {
  const [resolver, setResolver] = useState<((p: string | null) => void) | null>(null);
  const [path, setPath] = useState('');
  const [typed, setTyped] = useState('');
  const [dirs, setDirs] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(async (p: string): Promise<void> => {
    setError(null);
    try {
      const entries = await listDir(p);
      setDirs(entries.filter((e) => e.is_dir && !e.is_hidden));
      setPath(p);
      setTyped(p);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(
    () =>
      subscribeFolderPick((resolve) => {
        setResolver(() => resolve);
        void homeDir().then(browse, (e: unknown) => setError(String(e)));
      }),
    [browse],
  );

  if (!resolver) return null;

  const close = (result: string | null): void => {
    resolver(result);
    setResolver(null);
  };
  const up = parentPath(path);

  return (
    <div role="dialog" aria-modal="true" style={backdropStyle}>
      <div style={panelStyle}>
        <span style={{ fontSize: '0.875rem', letterSpacing: '0.08em' }}>CHOISIR UN DOSSIER SUR LE PC</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void browse(typed);
            }}
            style={inputStyle}
            aria-label="Chemin"
          />
          <button type="button" className="dt-btn" onClick={() => void browse(typed)}>
            Aller
          </button>
        </div>
        <div style={listStyle}>
          {up && (
            <button type="button" style={rowStyle} onClick={() => void browse(up)}>
              ⬆ ..
            </button>
          )}
          {dirs.map((d) => (
            <button key={d.path} type="button" style={rowStyle} onClick={() => void browse(d.path)}>
              📁 {d.name}
            </button>
          ))}
          {dirs.length === 0 && !error && (
            <span style={{ opacity: 0.6, padding: 8 }}>Aucun sous-dossier</span>
          )}
        </div>
        {error && <span style={{ color: 'var(--color-danger)', fontSize: '0.75rem' }}>{error}</span>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="dt-btn" onClick={() => close(null)}>
            Annuler
          </button>
          <button
            type="button"
            className="dt-btn dt-btn--primary"
            disabled={!path}
            onClick={() => close(path)}
          >
            Choisir ce dossier
          </button>
        </div>
      </div>
    </div>
  );
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 300,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--color-backdrop)',
  fontFamily: 'var(--font-pixel)',
};

const panelStyle: React.CSSProperties = {
  background: 'var(--color-bg)',
  border: '2px solid var(--color-border)',
  boxShadow: 'var(--shadow-pixel)',
  padding: '16px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  width: 'min(560px, 94vw)',
  maxHeight: '85vh',
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--color-bg-dark)',
  color: 'inherit',
  border: '2px solid var(--color-border)',
  padding: '8px',
  fontFamily: 'var(--font-pixel)',
  fontSize: '0.875rem',
};

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
  minHeight: 200,
  border: '2px solid var(--color-border)',
  background: 'var(--color-bg-dark)',
};

const rowStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  minHeight: 44,
  background: 'transparent',
  color: 'inherit',
  border: 'none',
  borderBottom: '1px solid var(--color-border)',
  fontFamily: 'var(--font-pixel)',
  fontSize: '0.875rem',
  cursor: 'pointer',
};
