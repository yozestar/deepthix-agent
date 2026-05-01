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

export type NotifKind = 'info' | 'success' | 'warn' | 'error';

export interface NotificationEvent {
  title: string;
  body: string;
  kind: NotifKind;
  source: string;
  ts_ms: number;
}

/** Subscribe to notifications dispatched from anywhere — Tauri commands,
 *  the deepthix-mcp sidecar, or the webview itself via notify_user. */
export async function onNotification(
  handler: (n: NotificationEvent) => void,
): Promise<UnlistenFn> {
  return await listen<NotificationEvent>('deepthix-notification', (event) => {
    log('deepthix-notification', {
      title: event.payload.title,
      kind: event.payload.kind,
      source: event.payload.source,
    });
    handler(event.payload);
  });
}

export interface ChatEvent {
  term_id: string;
  /** Raw JSON line as claude wrote it. The chat pane parses it. */
  line: string;
  stream: 'stdout' | 'stderr';
}

export async function onChatEvent(
  handler: (e: ChatEvent) => void,
): Promise<UnlistenFn> {
  return await listen<ChatEvent>('chat_event', (event) => {
    handler(event.payload);
  });
}

export interface ChatExitEvent {
  term_id: string;
  type: 'exit';
  code: number | null;
}

export async function onChatExit(
  handler: (e: ChatExitEvent) => void,
): Promise<UnlistenFn> {
  return await listen<ChatExitEvent>('chat_exit', (event) => {
    log('chat_exit', { termId: event.payload.term_id, code: event.payload.code });
    handler(event.payload);
  });
}
