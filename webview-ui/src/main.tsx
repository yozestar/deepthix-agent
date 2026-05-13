import './index.css';
// Inter — readable sans-serif used when uiFont === 'inter'. Bundled
// locally (no network) so the app stays offline-capable. Three weights
// cover regular / medium / semibold needs across the UI.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import { isBrowserRuntime, isTauriRuntime } from './runtime';

/**
 * WKWebView reports `window.devicePixelRatio = 1` even on Retina when
 * the page is loaded via Tauri's `tauri://` custom URL scheme (Wails#5111
 * has the canonical write-up; the Wry side has the same bug). xterm.js
 * caches glyph metrics at mount using whatever DPR is reported, so a
 * lying DPR makes every cell render at half-resolution → blurry text +
 * the box-drawing bleed our terminal showed.
 *
 * Tauri exposes the OS-reported scale factor on the window object. We
 * read it before React mounts and override `window.devicePixelRatio` if
 * it disagrees, so by the time xterm constructs itself the canvas
 * metrics line up with the physical pixels. Safe in browser too — the
 * import of `window.scaleFactor()` no-ops when not running under Tauri.
 */
async function reconcileDpr(): Promise<void> {
  if (!isTauriRuntime) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const real = await getCurrentWindow().scaleFactor();
    const reported = window.devicePixelRatio;
    if (Math.abs(real - reported) < 0.001) {
      console.info('[Deepthix][DPR] WKWebView matches OS', { real, reported });
      return;
    }
    console.warn('[Deepthix][DPR] WKWebView lying — overriding', { real, reported });
    Object.defineProperty(window, 'devicePixelRatio', {
      get: () => real,
      configurable: true,
    });
  } catch (e) {
    console.warn('[Deepthix][DPR] reconcile failed', e);
  }
}

async function main() {
  // DPR override MUST run before xterm (and any canvas-measuring code)
  // mounts — that's why it's awaited here at the top of main, not in a
  // useEffect somewhere downstream.
  await reconcileDpr();
  if (isBrowserRuntime || isTauriRuntime) {
    const { initBrowserMock } = await import('./browserMock.js');
    await initBrowserMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

main().catch(console.error);
