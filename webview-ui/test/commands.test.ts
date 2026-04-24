import assert from 'node:assert/strict';
import { test } from 'node:test';

test('command wrappers exist with expected signatures', async () => {
  const mod = await import('../src/tauri/commands.ts');
  assert.equal(typeof mod.openFolder, 'function');
  assert.equal(typeof mod.addProject, 'function');
  assert.equal(typeof mod.listProjects, 'function');
  assert.equal(typeof mod.switchProject, 'function');
  assert.equal(typeof mod.removeProject, 'function');
  assert.equal(typeof mod.listDir, 'function');
});
