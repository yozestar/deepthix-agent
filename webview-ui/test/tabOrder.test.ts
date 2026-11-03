import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tabOrderKey } from '../src/conversationUtils.ts';

const claude = (id: string, sessionId: string | null = 's') => ({ id, kind: 'claude', sessionId });

test('a conversation with a known last message sorts by that date', () => {
  assert.equal(tabOrderKey(claude('ghost:a'), 1_700), 1_700);
});

test('a session just launched (no transcript yet) goes first', () => {
  assert.equal(tabOrderKey(claude('chat-new'), 0), Number.MAX_SAFE_INTEGER);
  assert.equal(tabOrderKey(claude('chat-new'), undefined), Number.MAX_SAFE_INTEGER);
});

test('a paused session whose transcript is gone goes last among conversations', () => {
  const k = tabOrderKey(claude('ghost:lost'), 0);
  assert.ok(k < tabOrderKey(claude('ghost:old'), 1));
  assert.ok(k > tabOrderKey({ id: 'pty-1', kind: 'shell', sessionId: null }, undefined));
});

test('shells and sessions without id go to the end', () => {
  assert.equal(tabOrderKey({ id: 'pty-1', kind: 'shell', sessionId: null }, undefined), -1);
  assert.equal(tabOrderKey(claude('chat-x', null), undefined), -1);
});

test('sorting puts live-new first, then most recent, lost ones last', () => {
  const tabs = [claude('ghost:lost', 'l'), claude('ghost:old', 'o'), claude('chat-new', 'n'), claude('ghost:recent', 'r')];
  const mtimes: Record<string, number> = { o: 100, r: 900 };
  const sorted = [...tabs].sort((a, b) => tabOrderKey(b, mtimes[b.sessionId!]) - tabOrderKey(a, mtimes[a.sessionId!]));
  assert.deepEqual(sorted.map((t) => t.id), ['chat-new', 'ghost:recent', 'ghost:old', 'ghost:lost']);
});
