// TEAM SERVER client (design « utilisateurs et droits »): a colleague runs the
// app on his own computer and works locally (projects, sessions, his own Claude
// licence). Everything about agents lives on the Mac mini: this module opens a
// remote connection to it (same protocol as the phone UI) so the local app can
// fetch its rights and talk to the agents.
//
// Identity: Cloudflare Access (Microsoft account) — the login happens in the
// "Mac distant" window, whose cookies the main window shares. Device: the first
// connection asks for pairing, which an administrator accepts on the Mac mini.

import { isRemoteRuntime } from '../runtime';
import { createRemoteClient, invoke, type RemoteClient, type RemoteClientOptions } from './transport';

let client: RemoteClient | null = null;
let clientUrl = '';

/** localStorage with a prefix, so the team token never mixes with others. */
const teamStorage = {
  getItem: (k: string) => localStorage.getItem(`team:${k}`),
  setItem: (k: string, v: string) => localStorage.setItem(`team:${k}`, v),
  removeItem: (k: string) => localStorage.removeItem(`team:${k}`),
};

function wsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  return u.toString();
}

/** The team server address (the saved "Mac distant"), or '' when none. */
export async function teamServerUrl(): Promise<string> {
  if (isRemoteRuntime) return '';
  try {
    return (await invoke<string>('client_mode_get')) || '';
  } catch {
    return '';
  }
}

/** Remote client to the team server, created on first use. Null when none. */
export async function teamClient(): Promise<RemoteClient | null> {
  if (isRemoteRuntime) return null;
  const url = await teamServerUrl();
  if (!url) return null;
  if (!client || clientUrl !== url) {
    clientUrl = url;
    client = createRemoteClient({
      url: wsUrl(url),
      WebSocketImpl: WebSocket as unknown as RemoteClientOptions['WebSocketImpl'],
      storage: teamStorage,
      deviceName: `App Elyone (${navigator.platform || 'poste'})`,
    });
  }
  return client;
}
