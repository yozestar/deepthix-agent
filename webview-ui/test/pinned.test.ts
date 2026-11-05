import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitPinned } from '../src/conversationUtils.ts';

const g = (id: string, pinned_at_ms?: number | null) => ({ id, project: { pinned_at_ms } });

test('pinned projects come first, in the order they were pinned', () => {
  // Input is already "most recent activity first".
  const { pinned, others } = splitPinned([g('recent'), g('pinB', 200), g('older'), g('pinA', 100)]);
  assert.deepEqual(pinned.map((x) => x.id), ['pinA', 'pinB'], 'pin order, not activity');
  assert.deepEqual(others.map((x) => x.id), ['recent', 'older'], 'others keep recency order');
});

test('no pin: the list is unchanged', () => {
  const { pinned, others } = splitPinned([g('a'), g('b', null), g('c', 0)]);
  assert.equal(pinned.length, 0);
  assert.deepEqual(others.map((x) => x.id), ['a', 'b', 'c']);
});
