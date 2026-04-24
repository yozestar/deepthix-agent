/**
 * Thin Tauri IPC wrapper, mirrors the shape of vscodeApi.ts so call sites
 * can switch on runtime cleanly. Phase 0 only stubs out postMessage —
 * real command/event wiring lands in later phases.
 */
import { isTauriRuntime } from './runtime';

interface MessageBridge {
  postMessage(msg: unknown): void;
}

async function getTauri(): Promise<typeof import('@tauri-apps/api/core') | null> {
  if (!isTauriRuntime) return null;
  return await import('@tauri-apps/api/core');
}

export const tauri: MessageBridge = {
  postMessage(msg: unknown): void {
    // Phase 0: log only. Future phases will route specific message types
    // to typed Tauri commands via invoke().
    void getTauri().then((mod) => {
      if (mod) {
        // eslint-disable-next-line no-console
        console.log('[Deepthix][tauri.postMessage]', msg);
      }
    });
  },
};
