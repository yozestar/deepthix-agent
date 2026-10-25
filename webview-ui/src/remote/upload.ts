/**
 * Remote devices have no file paths on the PC: a picked / pasted / dropped
 * file is sent over the socket, saved by the agent in ~/.elyone/dropped/,
 * then handed to the chat exactly like a file dropped on the desktop.
 */

import { stashUploadBase64 } from '../tauri/commands';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i;
const CHUNK = 0x8000;

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Pasted screenshots often arrive unnamed ("image.png"): give them a stamp. */
function nameOf(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return `capture_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
}

/**
 * Uploads `files` and attaches them to the chat bound to `termId`: images
 * as preview thumbnails, other files as quoted paths in the composer.
 */
export async function uploadToChat(files: File[], termId: string): Promise<void> {
  const images: string[] = [];
  const others: string[] = [];
  for (const file of files) {
    const name = nameOf(file);
    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    const path = await stashUploadBase64(name, data);
    (isImageName(name) ? images : others).push(path);
  }
  if (images.length > 0) {
    window.dispatchEvent(
      new CustomEvent('deepthix:chat:add-attachments', { detail: { termId, paths: images } }),
    );
  }
  if (others.length > 0) {
    const text = others.map((p) => `"${p}"`).join(' ') + ' ';
    window.dispatchEvent(new CustomEvent('deepthix:chat:append-input', { detail: { termId, text } }));
  }
}
