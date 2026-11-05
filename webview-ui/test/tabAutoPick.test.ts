import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requestMostRecentTab, takeMostRecentTabRequest } from '../src/tabAutoPick.ts';

test('a request is honoured once, for its project only', () => {
  requestMostRecentTab('bee2link');
  assert.equal(takeMostRecentTabRequest('go-formations'), false, 'another project');
  assert.equal(takeMostRecentTabRequest('bee2link'), true);
  assert.equal(takeMostRecentTabRequest('bee2link'), false, 'only once');
});

test('no request: an explicitly opened conversation keeps its tab', () => {
  assert.equal(takeMostRecentTabRequest('bee2link'), false);
  assert.equal(takeMostRecentTabRequest(null), false);
});

test('the last project clicked wins', () => {
  requestMostRecentTab('a');
  requestMostRecentTab('b');
  assert.equal(takeMostRecentTabRequest('a'), false);
  assert.equal(takeMostRecentTabRequest('b'), true);
});
