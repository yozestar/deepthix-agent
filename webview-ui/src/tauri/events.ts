import { listen, type UnlistenFn } from '@tauri-apps/api/event';

function log(name: string, payload?: unknown): void {
  console.debug('[Deepthix][evt]', name, payload ?? '');
}

/** Fired when the active project changes (payload: project id). */
export async function onProjectSwitched(handler: (id: string) => void): Promise<UnlistenFn> {
  return await listen<string>('project_switched', (event) => {
    log('project_switched', event.payload);
    handler(event.payload);
  });
}
