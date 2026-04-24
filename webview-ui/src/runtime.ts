/**
 * Runtime detection, provider-agnostic.
 *
 * Determines whether the webview is running inside an IDE extension,
 * a Tauri desktop app, or standalone in a browser.
 */

declare function acquireVsCodeApi(): unknown;

type Runtime = 'vscode' | 'tauri' | 'browser';

function detectRuntime(): Runtime {
  if (typeof acquireVsCodeApi !== 'undefined') return 'vscode';
  // Use globalThis to avoid depending on the DOM `Window` lib type — this
  // module is also imported from the Node-based test runner config.
  const g = globalThis as { __TAURI_INTERNALS__?: unknown };
  if (typeof g !== 'undefined' && g.__TAURI_INTERNALS__) {
    return 'tauri';
  }
  return 'browser';
}

const runtime: Runtime = detectRuntime();

export const isBrowserRuntime = runtime === 'browser';
export const isTauriRuntime = runtime === 'tauri';
export const isVscodeRuntime = runtime === 'vscode';
export { runtime };
