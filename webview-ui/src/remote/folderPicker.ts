/**
 * Remote mode has no native folder dialog: `openFolder()` asks the mounted
 * <RemoteFolderPicker/> instead, which browses the PC with `listDir`.
 */

type Opener = (resolve: (path: string | null) => void) => void;

let opener: Opener | null = null;

export function subscribeFolderPick(open: Opener): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

export function requestFolderPick(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!opener) {
      resolve(null);
      return;
    }
    opener(resolve);
  });
}

const DRIVE = /^[A-Za-z]:$/;

/** Parent folder, or null at a drive / filesystem root. */
export function parentPath(path: string): string | null {
  const sep = path.includes('\\') ? '\\' : '/';
  const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  if (DRIVE.test(trimmed) || trimmed === '/') return null;
  const i = trimmed.lastIndexOf(sep);
  if (i < 0) return null;
  if (i === 0) return '/';
  const parent = trimmed.slice(0, i);
  return DRIVE.test(parent) ? `${parent}\\` : parent;
}
