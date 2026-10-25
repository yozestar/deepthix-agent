import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parentPath, requestFolderPick, subscribeFolderPick } from '../src/remote/folderPicker.ts';

test('parentPath on windows and posix paths', () => {
  assert.equal(parentPath('C:\\Users\\ia\\Dev'), 'C:\\Users\\ia');
  assert.equal(parentPath('C:\\Users'), 'C:\\');
  assert.equal(parentPath('C:\\'), null);
  assert.equal(parentPath('/home/ia/dev'), '/home/ia');
  assert.equal(parentPath('/home'), '/');
  assert.equal(parentPath('/'), null);
});

test('a pick request resolves with the chosen folder', async () => {
  const answers: ((p: string | null) => void)[] = [];
  const off = subscribeFolderPick((resolve) => answers.push(resolve));
  const p = requestFolderPick();
  assert.equal(answers.length, 1, 'picker was asked to open');
  answers[0]('C:\\Dev\\proj');
  assert.equal(await p, 'C:\\Dev\\proj');
  off();
});

test('a cancelled pick resolves null', async () => {
  const off = subscribeFolderPick((resolve) => resolve(null));
  assert.equal(await requestFolderPick(), null);
  off();
});

test('no mounted picker resolves null', async () => {
  assert.equal(await requestFolderPick(), null);
});
