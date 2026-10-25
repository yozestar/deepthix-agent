import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRemoteClient, type RemoteClientOptions } from '../src/tauri/transport.ts';

class FakeWS {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {}
  send(s: string): void {
    this.sent.push(JSON.parse(s) as Record<string, unknown>);
  }
  close(): void {
    this.drop();
  }
  // test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function setup(opts: Partial<RemoteClientOptions> = {}, token: string | null = 'tok') {
  // Per-test registry: clients from earlier tests keep reconnecting.
  const sockets: FakeWS[] = [];
  class TestWS extends FakeWS {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  const storage = memoryStorage(token ? { 'elyone.remote.token': token } : {});
  const client = createRemoteClient({
    url: 'ws://agent/ws',
    WebSocketImpl: TestWS as unknown as RemoteClientOptions['WebSocketImpl'],
    storage,
    deviceName: 'iPhone',
    backoffMs: [0],
    offlineTimeoutMs: 50,
    ...opts,
  });
  const ws = () => sockets[sockets.length - 1];
  return { client, storage, ws, sockets };
}

async function ready(ws: () => FakeWS): Promise<void> {
  ws().open();
  ws().emit({ t: 'ready' });
  await tick();
}

test('hello is sent with the stored token', () => {
  const { ws } = setup();
  ws().open();
  assert.deepEqual(ws().sent[0], { t: 'hello', token: 'tok' });
});

test('invoke resolves on result', async () => {
  const { client, ws } = setup();
  await ready(ws);
  const p = client.invoke<number>('echo_len', { someText: 'abc' });
  const sent = ws().sent[1];
  assert.equal(sent.t, 'invoke');
  assert.equal(sent.cmd, 'echo_len');
  assert.deepEqual(sent.args, { someText: 'abc' });
  ws().emit({ t: 'result', id: sent.id, ok: 3 });
  assert.equal(await p, 3);
});

test('invoke rejects on err', async () => {
  const { client, ws } = setup();
  await ready(ws);
  const p = client.invoke('nope');
  ws().emit({ t: 'result', id: ws().sent[1].id, err: 'boom' });
  await assert.rejects(p, /boom/);
});

test('invoke issued while connecting is sent after ready', async () => {
  const { client, ws } = setup();
  const p = client.invoke<string>('list_projects');
  ws().open();
  assert.equal(ws().sent.length, 1, 'only hello before ready');
  ws().emit({ t: 'ready' });
  const sent = ws().sent[1];
  assert.equal(sent.cmd, 'list_projects');
  ws().emit({ t: 'result', id: sent.id, ok: 'x' });
  assert.equal(await p, 'x');
});

test('invoke while offline rejects after the timeout', async () => {
  const { client } = setup();
  await assert.rejects(client.invoke('list_projects'), /offline/);
});

test('listen receives matching events only', async () => {
  const { client, ws } = setup();
  await ready(ws);
  const got: unknown[] = [];
  await client.listen<{ id: string }>('pty_data', (e) => got.push(e.payload));
  ws().emit({ t: 'event', name: 'chat_event', payload: { id: 'no' } });
  ws().emit({ t: 'event', name: 'pty_data', payload: { id: 'yes' } });
  assert.deepEqual(got, [{ id: 'yes' }]);
});

test('unlisten stops delivery', async () => {
  const { client, ws } = setup();
  await ready(ws);
  const got: unknown[] = [];
  const un = await client.listen('pty_data', (e) => got.push(e.payload));
  un();
  ws().emit({ t: 'event', name: 'pty_data', payload: 1 });
  assert.deepEqual(got, []);
});

test('reconnect re-registers listeners and fires onResync', async () => {
  const { client, ws } = setup();
  await ready(ws);
  const got: unknown[] = [];
  let resyncs = 0;
  await client.listen('pty_data', (e) => got.push(e.payload));
  client.onResync(() => resyncs++);
  const first = ws();
  first.drop();
  await tick();
  assert.notEqual(ws(), first, 'a new socket was opened');
  assert.equal(client.state().status, 'offline');
  await ready(ws);
  assert.equal(resyncs, 1);
  ws().emit({ t: 'event', name: 'pty_data', payload: 'again' });
  assert.deepEqual(got, ['again']);
});

test('dropped connection rejects in-flight invokes', async () => {
  const { client, ws } = setup();
  await ready(ws);
  const p = client.invoke('slow');
  ws().drop();
  await assert.rejects(p, /connection lost/);
});

test('bye rejects pending invokes', async () => {
  const { client, ws } = setup();
  await ready(ws);
  const p = client.invoke('hang');
  ws().emit({ t: 'bye', reason: 'disabled' });
  await assert.rejects(p, /disabled/);
});

test('pairing stores token', async () => {
  const { client, storage, ws } = setup({}, null);
  ws().open();
  assert.deepEqual(ws().sent[0], { t: 'pair', name: 'iPhone' });
  ws().emit({ t: 'pair_pending', code: '123456' });
  assert.deepEqual(client.state(), { status: 'pairing', code: '123456' });
  ws().emit({ t: 'paired', token: 'new-token' });
  ws().emit({ t: 'ready' });
  assert.equal(storage.map.get('elyone.remote.token'), 'new-token');
  assert.equal(client.state().status, 'ready');
});

test('revoked device forgets its token and stops reconnecting', async () => {
  const { client, storage, ws, sockets } = setup();
  await ready(ws);
  const count = sockets.length;
  ws().emit({ t: 'bye', reason: 'revoked' });
  ws().drop();
  await tick(20);
  assert.equal(client.state().status, 'denied');
  assert.equal(storage.map.has('elyone.remote.token'), false);
  assert.equal(sockets.length, count, 'no reconnect');
});

test('state subscribers are notified', async () => {
  const { client, ws } = setup();
  const seen: string[] = [];
  client.subscribe((s) => seen.push(s.status));
  await ready(ws);
  assert.ok(seen.includes('ready'));
});

test('push subscription is sent to the agent', async () => {
  const { client, ws } = setup();
  await ready(ws);
  const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } };
  client.pushSubscribe(sub);
  assert.deepEqual(ws().sent[1], { t: 'push_subscribe', subscription: sub });
});
