// File actions shared by the Files tree and the "no preview" placeholder.
// On the PC: open with the default app (Word, Excel, Aperçu…) or show it in
// the Finder / Explorer. On a remote device those would act on the PC's
// screen, so there it is "Télécharger" instead (bytes go through the tunnel).

import { Download, ExternalLink, FolderSearch } from 'lucide-react';
import { useState } from 'react';

import { REMOTE_DOWNLOAD_MAX_BYTES } from '../constants';
import { isRemoteRuntime } from '../runtime';
import { fileSize, openPath, readFileBytesBase64, revealPath } from '../tauri/commands';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const REVEAL_LABEL = IS_MAC ? 'Afficher dans le Finder' : 'Afficher dans l’Explorateur';

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

/** Remote: fetch the file through the tunnel and hand it to the browser. */
async function downloadFile(path: string): Promise<void> {
  const size = await fileSize(path);
  if (size > REMOTE_DOWNLOAD_MAX_BYTES) {
    throw new Error(
      `Fichier trop gros pour le téléchargement à distance (${Math.round(size / 1_048_576)} Mo, max ${REMOTE_DOWNLOAD_MAX_BYTES / 1_048_576} Mo)`,
    );
  }
  const { b64, mime } = await readFileBytesBase64(path);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = basename(path);
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function report(err: unknown): void {
  console.warn('[Elyone][FileActions]', err);
}

/** Small icon buttons for a tree row (same look as the copy-path button). */
export function FileRowActions({ path, isDir }: { path: string; isDir: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = (e: React.MouseEvent, op: () => Promise<void>): void => {
    e.stopPropagation();
    setBusy(true);
    setErr(null);
    op()
      .catch((x: unknown) => {
        report(x);
        setErr(x instanceof Error ? x.message : String(x));
      })
      .finally(() => setBusy(false));
  };

  if (isRemoteRuntime) {
    if (isDir) return <></>;
    return (
      <button
        type="button"
        className="dt-tree-copy"
        title={err ?? 'Télécharger'}
        aria-label={`Télécharger ${basename(path)}`}
        disabled={busy}
        onClick={(e) => act(e, () => downloadFile(path))}
        style={err ? { color: 'var(--color-danger)', opacity: 1 } : undefined}
      >
        <Download size="1em" strokeWidth={2} aria-hidden />
      </button>
    );
  }
  return (
    <>
      {!isDir && (
        <button
          type="button"
          className="dt-tree-copy"
          title="Ouvrir avec l’application par défaut"
          aria-label={`Ouvrir ${basename(path)}`}
          onClick={(e) => act(e, () => openPath(path))}
        >
          <ExternalLink size="1em" strokeWidth={2} aria-hidden />
        </button>
      )}
      <button
        type="button"
        className="dt-tree-copy"
        title={REVEAL_LABEL}
        aria-label={`${REVEAL_LABEL} : ${basename(path)}`}
        onClick={(e) => act(e, () => revealPath(path))}
      >
        <FolderSearch size="1em" strokeWidth={2} aria-hidden />
      </button>
    </>
  );
}

/** Labelled buttons for the "no preview available" placeholder. */
export function FileOpenButtons({ path }: { path: string }): React.JSX.Element {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (op: () => Promise<void>): void => {
    setBusy(true);
    setErr(null);
    op()
      .catch((x: unknown) => {
        report(x);
        setErr(x instanceof Error ? x.message : String(x));
      })
      .finally(() => setBusy(false));
  };
  const btn: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    minHeight: 44,
    background: 'var(--color-accent)',
    color: 'var(--color-on-accent)',
    border: '2px solid var(--color-border)',
    boxShadow: 'var(--shadow-pixel)',
    fontFamily: 'var(--font-pixel)',
    fontSize: '0.8125rem',
    cursor: 'pointer',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginTop: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
        {isRemoteRuntime ? (
          <button type="button" style={btn} disabled={busy} onClick={() => act(() => downloadFile(path))}>
            <Download size={16} aria-hidden /> {busy ? 'Téléchargement…' : 'Télécharger'}
          </button>
        ) : (
          <>
            <button type="button" style={btn} onClick={() => act(() => openPath(path))}>
              <ExternalLink size={16} aria-hidden /> Ouvrir
            </button>
            <button
              type="button"
              style={{ ...btn, background: 'var(--color-btn-bg)', color: 'var(--color-text)' }}
              onClick={() => act(() => revealPath(path))}
            >
              <FolderSearch size={16} aria-hidden /> {REVEAL_LABEL}
            </button>
          </>
        )}
      </div>
      {err && <span style={{ color: 'var(--color-danger)', fontSize: '0.75rem' }}>{err}</span>}
    </div>
  );
}
