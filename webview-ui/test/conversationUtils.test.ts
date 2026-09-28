import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  avatarColor,
  computeTurnFooters,
  formatWhen,
  initials,
  matches,
} from '../src/conversationUtils.ts';

test('initials: two words, separators, single word', () => {
  assert.equal(initials('Odoo Kaliop'), 'OK');
  assert.equal(initials('claude_agent'), 'CA');
  assert.equal(initials('bee2link'), 'BE');
  assert.equal(initials(''), '?');
});

test('avatarColor is stable per id', () => {
  assert.equal(avatarColor('p1'), avatarColor('p1'));
  assert.match(avatarColor('anything'), /^#[0-9A-F]{6}$/i);
});

test('formatWhen: today / yesterday / week / older', () => {
  const now = new Date(2026, 8, 28, 16, 0).getTime();
  assert.equal(formatWhen(new Date(2026, 8, 28, 9, 5).getTime(), now), '09:05');
  assert.equal(formatWhen(new Date(2026, 8, 27, 23, 0).getTime(), now), 'hier');
  assert.equal(formatWhen(new Date(2026, 8, 10, 12, 0).getTime(), now), '10/09');
  assert.equal(formatWhen(0, now), '');
});

test('matches ignores case and accents', () => {
  assert.ok(matches('Émissions FE02', 'emission'));
  assert.ok(matches('Relance', 'LANC'));
  assert.ok(!matches('Odoo', 'hubspot'));
});

test('computeTurnFooters: one footer per answered turn, tools counted', () => {
  const msgs = [
    { kind: 'user', ts: 1_000 },
    { kind: 'assistant_text', ts: 2_000 },
    { kind: 'tool_use', tool: 'Bash', ts: 3_000 },
    { kind: 'tool_use', tool: '(result)', ts: 4_000 },
    { kind: 'assistant_text', ts: 34_000 },
    { kind: 'user', ts: 40_000 },
    { kind: 'user', ts: 41_000 },
  ];
  const f = computeTurnFooters(msgs);
  assert.deepEqual([...f.keys()], [4]);
  assert.deepEqual(f.get(4), { durationMs: 33_000, tools: 1, endTs: 34_000 });
});
