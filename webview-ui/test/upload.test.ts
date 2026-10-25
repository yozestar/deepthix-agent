import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bytesToBase64, isImageName } from '../src/remote/upload.ts';

test('bytesToBase64 matches standard base64, also on large buffers', () => {
  assert.equal(bytesToBase64(new Uint8Array([104, 105])), 'aGk=');
  const big = new Uint8Array(200_000).map((_, i) => i % 256);
  assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'));
});

test('isImageName recognises common photo formats', () => {
  for (const n of ['a.png', 'B.JPG', 'c.jpeg', 'd.heic', 'e.webp', 'f.gif']) assert.ok(isImageName(n), n);
  for (const n of ['a.pdf', 'b.txt', 'noext']) assert.ok(!isImageName(n), n);
});
