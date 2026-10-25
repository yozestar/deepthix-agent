// Driven by the Rust test `remote::server::tests::e2e_with_real_ts_client`
// (cargo test -- --ignored). Speaks to a real Hub with the real transport
// client; prints step markers on stdout, exits non-zero on any mismatch.
//   node --import tsx/esm test-e2e/remote-client.e2e.ts <port> <token>

import { createInterface } from 'node:readline';

import { createRemoteClient, type RemoteClientOptions } from '../src/tauri/transport.ts';

const [port, token] = process.argv.slice(2);
const storage = new Map<string, string>([['elyone.remote.token', token]]);

function fail(msg: string): never {
  console.log(`FAIL ${msg}`);
  process.exit(1);
}

const client = createRemoteClient({
  url: `ws://127.0.0.1:${port}/ws`,
  WebSocketImpl: WebSocket as unknown as RemoteClientOptions['WebSocketImpl'],
  storage: {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => void storage.set(k, v),
    removeItem: (k) => void storage.delete(k),
  },
  deviceName: 'e2e',
  backoffMs: [100],
  offlineTimeoutMs: 5000,
});

const timeout = setTimeout(() => fail('timeout'), 20000);
const stdin = createInterface({ input: process.stdin });

const echoed = await client.invoke<{ a: number }>('echo', { a: 1 });
if (echoed.a !== 1) fail(`echo returned ${JSON.stringify(echoed)}`);

try {
  await client.invoke('nope');
  fail('nope should reject');
} catch (e) {
  if (!String(e).includes('unknown nope')) fail(`wrong error ${String(e)}`);
}

const event = new Promise<unknown>((resolve) => {
  void client.listen('pty_data', (e) => resolve(e.payload));
});
console.log('READY');
const payload = (await event) as { data?: string };
if (payload.data !== 'hi') fail(`event payload ${JSON.stringify(payload)}`);
console.log('EVENT_OK');

// Rust revokes the device after EVENT_OK; the client must lock itself out.
await new Promise<void>((resolve) => {
  const off = client.subscribe((s) => {
    if (s.status === 'denied') {
      off();
      resolve();
    }
  });
});
if (storage.has('elyone.remote.token')) fail('token kept after revoke');
console.log('DONE');
clearTimeout(timeout);
stdin.close();
process.exit(0);
