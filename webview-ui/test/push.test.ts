import assert from 'node:assert/strict';
import { test } from 'node:test';

import { base64UrlToBytes } from '../src/remote/push.ts';

test('base64UrlToBytes decodes unpadded base64url', () => {
  assert.deepEqual([...base64UrlToBytes('AQID_-8')], [1, 2, 3, 255, 239]);
  assert.deepEqual([...base64UrlToBytes('')], []);
});
