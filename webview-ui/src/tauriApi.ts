/**
 * Tauri IPC bridge for the webview's `vscode.postMessage` calls.
 *
 * The webview was authored against the VS Code extension protocol. To avoid
 * touching every call site, we accept the same `postMessage({ type, ... })`
 * shape and route known message types to the corresponding Tauri command.
 *
 * Unknown types are logged and ignored. New routes land here as new phases
 * wire more behaviors through the bridge.
 */
import * as commands from './tauri/commands';

interface MessageBridge {
  postMessage(msg: unknown): void;
}

/**
 * The active project id used as the scope for layout saves. Set externally
 * (App.tsx subscribes to project changes and calls setActiveProjectId).
 * If null, saveLayout is dropped with a warning.
 */
let activeProjectId: string | null = null;
let activeProjectPath: string | null = null;
let onOpenTerminal: ((cwd: string, kind: 'shell' | 'claude') => void) | null = null;

export function setActiveProjectId(id: string | null): void {
  console.debug('[Deepthix][bridge] setActiveProjectId', id);
  activeProjectId = id;
}

export function setActiveProjectPath(path: string | null): void {
  console.debug('[Deepthix][bridge] setActiveProjectPath', path);
  activeProjectPath = path;
}

export function setOnOpenTerminal(
  fn: ((cwd: string, kind: 'shell' | 'claude') => void) | null,
): void {
  console.debug('[Deepthix][bridge] setOnOpenTerminal', !!fn);
  onOpenTerminal = fn;
}

interface SaveLayoutMsg {
  type: 'saveLayout';
  layout: unknown;
}

interface OpenClaudeMsg {
  type: 'openClaude';
}

function isSaveLayoutMsg(msg: unknown): msg is SaveLayoutMsg {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'saveLayout'
  );
}

function isOpenClaudeMsg(msg: unknown): msg is OpenClaudeMsg {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'openClaude'
  );
}

export const tauri: MessageBridge = {
  postMessage(msg: unknown): void {
    if (isSaveLayoutMsg(msg)) {
      if (activeProjectId === null) {
        console.warn('[Deepthix][bridge] saveLayout dropped — no active project');
        return;
      }
      void commands.saveLayout(activeProjectId, msg.layout).catch((err) => {
        console.error('[Deepthix][bridge] saveLayout failed', err);
      });
      return;
    }
    if (isOpenClaudeMsg(msg)) {
      if (!activeProjectPath || !onOpenTerminal) {
        console.warn(
          '[Deepthix][bridge] openClaude dropped — no active project / no terminal handler',
          { activeProjectPath, hasHandler: !!onOpenTerminal },
        );
        return;
      }
      console.debug('[Deepthix][bridge] openClaude → spawn claude agent', activeProjectPath);
      onOpenTerminal(activeProjectPath, 'claude');
      return;
    }
    // Future phases will route more message types (saveAgentSeats, settings, etc.)
    console.debug('[Deepthix][bridge] unrouted postMessage', msg);
  },
};
