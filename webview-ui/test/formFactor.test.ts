import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyFormFactor } from '../src/hooks/useFormFactor.ts';

test('classifyFormFactor', () => {
  assert.equal(classifyFormFactor(1400, false), 'desktop');
  assert.equal(classifyFormFactor(800, true), 'tablet');
  assert.equal(classifyFormFactor(400, true), 'phone');
  assert.equal(classifyFormFactor(800, false), 'desktop');
  assert.equal(classifyFormFactor(1200, true), 'desktop');
  assert.equal(classifyFormFactor(519, true), 'phone');
  assert.equal(classifyFormFactor(520, true), 'tablet');
});
