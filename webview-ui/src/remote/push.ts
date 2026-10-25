/**
 * Web Push on the remote device (iOS: only once added to the home screen).
 * The agent's VAPID public key is injected into index.html by its server.
 */

import type { RemoteClient } from '../tauri/transport';

declare global {
  interface Window {
    __ELYONE_VAPID__?: string;
  }
  interface Navigator {
    /** iOS Safari: true when launched from the home screen. */
    standalone?: boolean;
  }
}

const SERVICE_WORKER_URL = '/sw.js';

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    typeof Notification !== 'undefined' &&
    !!window.__ELYONE_VAPID__
  );
}

/** Home-screen web app (where iOS allows push). */
export function isStandalone(): boolean {
  return (
    navigator.standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
  );
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(window.__ELYONE_VAPID__ ?? ''),
  });
}

/** Must run from a tap (iOS asks for permission only on a user gesture). */
export async function enablePush(client: RemoteClient): Promise<NotificationPermission | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  const sub = await currentSubscription();
  if (sub) client.pushSubscribe(sub.toJSON());
  return permission;
}

/** After each (re)connection: re-send the subscription if already allowed. */
export async function refreshPush(client: RemoteClient): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const sub = await currentSubscription();
    if (sub) client.pushSubscribe(sub.toJSON());
  } catch (e) {
    console.warn('[Elyone][push] refresh failed', e);
  }
}
