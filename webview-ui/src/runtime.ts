/**
 * Runtime detection, provider-agnostic.
 *
 * Determines whether the webview is running inside an IDE extension,
 * a Tauri desktop app, or standalone in a browser.
 */

declare function acquireVsCodeApi(): unknown;

type Runtime = 'vscode' | 'tauri' | 'remote' | 'browser';

interface RuntimeGlobals {
  __TAURI_INTERNALS__?: unknown;
  /** Injected by the agent's remote-access server into index.html. */
  __ELYONE_REMOTE__?: unknown;
}

export function detectRuntimeFrom(g: RuntimeGlobals): Runtime {
  if (g.__ELYONE_REMOTE__) return 'remote';
  if (g.__TAURI_INTERNALS__) return 'tauri';
  return 'browser';
}

function detectRuntime(): Runtime {
  if (typeof acquireVsCodeApi !== 'undefined') return 'vscode';
  // Use globalThis to avoid depending on the DOM `Window` lib type — this
  // module is also imported from the Node-based test runner config.
  return detectRuntimeFrom(globalThis as RuntimeGlobals);
}

const runtime: Runtime = detectRuntime();

export const isBrowserRuntime = runtime === 'browser';
export const isTauriRuntime = runtime === 'tauri';
export const isVscodeRuntime = runtime === 'vscode';
export const isRemoteRuntime = runtime === 'remote';
export { runtime };
