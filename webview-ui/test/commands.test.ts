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
  assert.equal(typeof mod.saveLayout, 'function');
  assert.equal(typeof mod.loadLayout, 'function');
});

test('remote access wrappers exist', async () => {
  const mod = await import('../src/tauri/commands.ts');
  assert.equal(typeof mod.remoteGetStatus, 'function');
  assert.equal(typeof mod.remoteSetEnabled, 'function');
  assert.equal(typeof mod.remoteRevokeDevice, 'function');
  assert.equal(typeof mod.remotePairRespond, 'function');
  assert.equal(typeof mod.remoteSetCf, 'function');
});

test('remote pair request event subscription exists', async () => {
  const mod = await import('../src/tauri/events.ts');
  assert.equal(typeof mod.onRemotePairRequest, 'function');
});

test('homeDir wrapper exists', async () => {
  const mod = await import('../src/tauri/commands.ts');
  assert.equal(typeof mod.homeDir, 'function');
});

test('autostart wrappers exist', async () => {
  const mod = await import('../src/tauri/commands.ts');
  assert.equal(typeof mod.getAutostart, 'function');
  assert.equal(typeof mod.setAutostart, 'function');
});
