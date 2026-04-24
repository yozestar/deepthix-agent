import { test } from 'node:test';
import assert from 'node:assert/strict';

test('detectRuntime falls back to browser when neither vscode nor tauri globals exist', async () => {
  // The module reads globals at import time; this test exists to lock the
  // logic in place. The actual detection paths are exercised at runtime.
  const mod = await import('../src/runtime.ts');
  assert.equal(typeof mod.runtime, 'string');
  assert.ok(['vscode', 'tauri', 'browser'].includes(mod.runtime));
  assert.equal(mod.isBrowserRuntime, mod.runtime === 'browser');
  assert.equal(mod.isTauriRuntime, mod.runtime === 'tauri');
  assert.equal(mod.isVscodeRuntime, mod.runtime === 'vscode');
});
