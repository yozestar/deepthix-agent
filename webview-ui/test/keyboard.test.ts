import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keyboardOpen } from '../src/hooks/useFormFactor.ts';

test('keyboard up: a field has focus and the visible height dropped', () => {
  // iPhone Duo unfolded: ~950 px tall, keyboard takes ~half.
  assert.equal(keyboardOpen(480, 950, true), true);
  // iPhone 12: 750 px, keyboard ~300 px.
  assert.equal(keyboardOpen(450, 750, true), true);
});

test('no keyboard: nothing focused, or only the browser bars moved', () => {
  assert.equal(keyboardOpen(480, 950, false), false, 'no focused field');
  assert.equal(keyboardOpen(900, 950, true), false, 'Safari toolbar collapsing is not a keyboard');
  assert.equal(keyboardOpen(500, 0, true), false, 'no reference height yet');
});
