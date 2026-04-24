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

export interface PtyDataEvent {
  id: string;
  data: string;
}

export async function onPtyData(handler: (e: PtyDataEvent) => void): Promise<UnlistenFn> {
  return await listen<PtyDataEvent>('pty_data', (event) => {
    handler(event.payload);
  });
}

export interface AgentJsonlEvent {
  id: string;
  session_id: string;
  line: string;
}

export async function onAgentJsonlLine(
  handler: (e: AgentJsonlEvent) => void,
): Promise<UnlistenFn> {
  return await listen<AgentJsonlEvent>('agent_jsonl_line', (event) => {
    log('agent_jsonl_line', { id: event.payload.id, bytes: event.payload.line.length });
    handler(event.payload);
  });
}
