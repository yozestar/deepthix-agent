import { isBrowserRuntime, isTauriRuntime } from './runtime';
import { tauri } from './tauriApi';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

function makeBridge(): { postMessage(msg: unknown): void } {
  if (isTauriRuntime) return tauri;
  if (isBrowserRuntime) {
    return { postMessage: (msg: unknown) => console.log('[Deepthix][bridge.browser]', msg) };
  }
  return acquireVsCodeApi();
}

// Name kept as `vscode` to avoid touching every call site in this phase.
// Real renaming/typed IPC lands in later phases.
export const vscode: { postMessage(msg: unknown): void } = makeBridge();
