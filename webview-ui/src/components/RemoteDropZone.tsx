// Remote devices only: drop files anywhere on the page to attach them to the
// session on screen (the desktop uses TerminalDropTarget + native paths).
// Files are uploaded to the PC first — see remote/upload.ts.

import { useEffect, useState } from 'react';

import { uploadToChat } from '../remote/upload';

interface Props {
  activeTermId: string | null;
}

export function RemoteDropZone({ activeTermId }: Props): React.JSX.Element | null {
  const [hovering, setHovering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files');
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      // Without this the browser would open the file instead of dropping it.
      e.preventDefault();
      setHovering(true);
    };
    const onLeave = (e: DragEvent): void => {
      if (e.relatedTarget === null) setHovering(false);
    };
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setHovering(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      if (!activeTermId) {
        setError('Ouvre une session avant de déposer un fichier.');
        return;
      }
      setError(null);
      uploadToChat(files, activeTermId).catch((err: unknown) => setError(`Envoi du fichier : ${String(err)}`));
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [activeTermId]);

  if (!hovering && !error) return null;
  return (
    <div
      role="status"
      onClick={() => setError(null)}
      style={{
        position: 'fixed',
        inset: hovering ? 0 : 'auto 12px 12px 12px',
        zIndex: 450,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
        background: hovering ? 'var(--color-backdrop)' : 'var(--color-bg)',
        border: hovering ? '3px dashed var(--color-accent)' : '2px solid var(--color-danger)',
        color: 'var(--color-text)',
        fontFamily: 'var(--font-pixel)',
        fontSize: hovering ? '1.125rem' : '0.875rem',
        pointerEvents: hovering ? 'none' : 'auto',
      }}
    >
      {hovering ? 'Lâche le fichier pour le joindre à la session' : error}
    </div>
  );
}
