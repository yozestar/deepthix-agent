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

/**
 * Re-dispatches a saved layout into the webview's existing message protocol
 * so the office canvas re-renders without changes to the consumer code.
 */
export function dispatchLayoutLoaded(layout: unknown): void {
  console.debug('[Deepthix][evt] dispatch layoutLoaded', !!layout);
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'layoutLoaded', layout } }),
  );
}
