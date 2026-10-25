/**
 * IPC transport. Inside the desktop app this is Tauri's own `invoke` /
 * `listen`. When the UI is served to a remote browser (iPhone, other PC)
 * the same calls travel over one WebSocket to the agent's remote server.
 * `commands.ts` / `events.ts` import from here, so components never know
 * where they run.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

import {
  REMOTE_BACKOFF_MS,
  REMOTE_OFFLINE_TIMEOUT_MS,
  REMOTE_TOKEN_STORAGE_KEY,
} from '../constants';
import { isRemoteRuntime } from '../runtime';

export type { UnlistenFn };

export type RemoteStatus = 'connecting' | 'pairing' | 'ready' | 'denied' | 'offline';

export interface RemoteState {
  status: RemoteStatus;
  code?: string;
}

export interface RemoteEvent<T> {
  event: string;
  payload: T;
}

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

interface SocketLike {
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RemoteClientOptions {
  url: string;
  WebSocketImpl: new (url: string) => SocketLike;
  storage: StorageLike;
  deviceName: string;
  backoffMs?: readonly number[];
  offlineTimeoutMs?: number;
}

export interface RemoteClient {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (e: RemoteEvent<T>) => void): Promise<UnlistenFn>;
  onResync(cb: () => void): () => void;
  state(): RemoteState;
  subscribe(cb: (s: RemoteState) => void): () => void;
  /** Starts a new pairing request after a refusal / revocation. */
  retry(): void;
  /** Registers this device's Web Push subscription with the agent. */
  pushSubscribe(subscription: unknown): void;
}

type ServerMsg =
  | { t: 'ready' }
  | { t: 'pair_pending'; code: string }
  | { t: 'paired'; token: string }
  | { t: 'pair_denied' }
  | { t: 'result'; id: number; ok?: unknown; err?: string }
  | { t: 'event'; name: string; payload: unknown }
  | { t: 'bye'; reason: string };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface Queued extends Pending {
  id: number;
  cmd: string;
  args: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
}

/** Reasons after which the device must not silently reconnect. */
const TERMINAL_REASONS = new Set(['revoked', 'unknown device', 'pairing denied']);
const OPEN = 1;

export function createRemoteClient(opts: RemoteClientOptions): RemoteClient {
  const backoff = opts.backoffMs ?? REMOTE_BACKOFF_MS;
  const offlineTimeout = opts.offlineTimeoutMs ?? REMOTE_OFFLINE_TIMEOUT_MS;
  let ws: SocketLike | null = null;
  let current: RemoteState = { status: 'connecting' };
  let nextId = 1;
  let attempt = 0;
  let everReady = false;
  let stopped = false;
  const inFlight = new Map<number, Pending>();
  const queue: Queued[] = [];
  const listeners = new Map<string, Set<(e: RemoteEvent<unknown>) => void>>();
  const resyncs = new Set<() => void>();
  const subscribers = new Set<(s: RemoteState) => void>();

  const setState = (s: RemoteState): void => {
    current = s;
    subscribers.forEach((cb) => cb(s));
  };

  const send = (msg: unknown): void => {
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
  };

  const flushQueue = (): void => {
    while (queue.length > 0) {
      const q = queue.shift()!;
      clearTimeout(q.timer);
      inFlight.set(q.id, q);
      send({ t: 'invoke', id: q.id, cmd: q.cmd, args: q.args });
    }
  };

  const rejectInFlight = (reason: string): void => {
    inFlight.forEach((p) => p.reject(new Error(reason)));
    inFlight.clear();
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    setTimeout(connect, delay);
  };

  const onMessage = (msg: ServerMsg): void => {
    switch (msg.t) {
      case 'ready': {
        attempt = 0;
        setState({ status: 'ready' });
        flushQueue();
        if (everReady) resyncs.forEach((cb) => cb());
        everReady = true;
        break;
      }
      case 'pair_pending':
        setState({ status: 'pairing', code: msg.code });
        break;
      case 'paired':
        opts.storage.setItem(REMOTE_TOKEN_STORAGE_KEY, msg.token);
        break;
      case 'pair_denied':
        setState({ status: 'denied' });
        break;
      case 'result': {
        const p = inFlight.get(msg.id);
        if (!p) return;
        inFlight.delete(msg.id);
        if (msg.err !== undefined) p.reject(new Error(msg.err));
        else p.resolve(msg.ok);
        break;
      }
      case 'event':
        listeners.get(msg.name)?.forEach((h) => h({ event: msg.name, payload: msg.payload }));
        break;
      case 'bye':
        rejectInFlight(msg.reason);
        if (TERMINAL_REASONS.has(msg.reason)) {
          stopped = true;
          if (msg.reason !== 'pairing denied') opts.storage.removeItem(REMOTE_TOKEN_STORAGE_KEY);
          setState({ status: 'denied' });
        }
        break;
    }
  };

  function connect(): void {
    if (stopped) return;
    const sock = new opts.WebSocketImpl(opts.url);
    ws = sock;
    if (current.status !== 'offline') setState({ status: 'connecting' });
    sock.onopen = () => {
      const token = opts.storage.getItem(REMOTE_TOKEN_STORAGE_KEY);
      send(token ? { t: 'hello', token } : { t: 'pair', name: opts.deviceName });
    };
    sock.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data) as ServerMsg);
      } catch (err) {
        console.warn('[Elyone][remote] bad message', err);
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      rejectInFlight('connection lost');
      if (stopped) return;
      setState({ status: 'offline' });
      scheduleReconnect();
    };
    sock.onerror = () => {
      // onclose follows and handles the reconnect.
    };
  }

  connect();

  return {
    invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = nextId++;
        const pending: Pending = { resolve: resolve as (v: unknown) => void, reject };
        if (current.status === 'ready' && ws && ws.readyState === OPEN) {
          inFlight.set(id, pending);
          send({ t: 'invoke', id, cmd, args });
          return;
        }
        const timer = setTimeout(() => {
          const i = queue.findIndex((q) => q.id === id);
          if (i >= 0) queue.splice(i, 1);
          reject(new Error(`offline: ${cmd}`));
        }, offlineTimeout);
        queue.push({ ...pending, id, cmd, args, timer });
      });
    },
    async listen<T>(event: string, handler: (e: RemoteEvent<T>) => void): Promise<UnlistenFn> {
      const h = handler as (e: RemoteEvent<unknown>) => void;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(h);
      return () => {
        listeners.get(event)?.delete(h);
      };
    },
    onResync(cb: () => void): () => void {
      resyncs.add(cb);
      return () => resyncs.delete(cb);
    },
    state: () => current,
    subscribe(cb: (s: RemoteState) => void): () => void {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    pushSubscribe(subscription: unknown): void {
      send({ t: 'push_subscribe', subscription });
    },
    retry(): void {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },
  };
}

function guessDeviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'PC Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'Navigateur';
}

/** The singleton used by the app when served remotely; null on desktop. */
export const remoteClient: RemoteClient | null = isRemoteRuntime
  ? createRemoteClient({
      url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      WebSocketImpl: WebSocket as unknown as RemoteClientOptions['WebSocketImpl'],
      storage: localStorage,
      deviceName: guessDeviceName(),
    })
  : null;

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return remoteClient ? remoteClient.invoke<T>(cmd, args) : tauriInvoke<T>(cmd, args);
}

export function listen<T>(
  event: string,
  handler: (e: RemoteEvent<T>) => void,
): Promise<UnlistenFn> {
  return remoteClient ? remoteClient.listen<T>(event, handler) : tauriListen<T>(event, handler);
}

/** Fired after every reconnect (remote only) so live panes can reload. */
export function onResync(cb: () => void): () => void {
  return remoteClient ? remoteClient.onResync(cb) : () => {};
}
