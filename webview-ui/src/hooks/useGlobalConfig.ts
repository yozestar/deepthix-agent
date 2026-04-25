// Global app config hook (Phase 11). Single source of truth for cross-project
// preferences — currently terminal font/zoom/line-height. Persists to
// `~/.deepthix/config.json` via the read_global_config / write_global_config
// Tauri commands. Mounted ONCE in App.tsx, threaded through props to every
// pane / hook that needs to read or mutate the values.
//
// Mutation flow:
//   1. caller invokes `update({ key: value })`
//   2. local state updates synchronously (so the UI re-renders right away)
//   3. a 250ms-debounced timer flushes the pending state to disk
//
// The debounce keeps Cmd+= / Cmd+- spam from hammering the disk while still
// guaranteeing the latest values get persisted.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  TERMINAL_DEFAULT_FONT_FAMILY,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_DEFAULT_LINE_HEIGHT,
} from '../constants';
import {
  type GlobalConfigPayload,
  readGlobalConfig as cmdReadGlobalConfig,
  writeGlobalConfig as cmdWriteGlobalConfig,
} from '../tauri/commands';
import { applyTheme, DEFAULT_THEME_ID } from '../themes';

/** Push the chosen font family into --font-pixel so every UI element using
 *  `var(--font-pixel)` (sidebar, tabs, modals, etc.) follows the user's pick.
 *  The terminal continues to read settings.terminalFontFamily directly. */
function applyAppFont(family: string): void {
  document.documentElement.style.setProperty('--font-pixel', family);
}

/** Resolved global config — every field is concrete (no `null` / `undefined`). */
export interface GlobalConfig {
  /** Font size in CSS pixels. Clamped 8..32 by callers. */
  terminalFontSize: number;
  /** CSS font-family list applied to the xterm canvas. */
  terminalFontFamily: string;
  /** Line-height multiplier (1.0–1.6). 1.0 = xterm default. */
  terminalLineHeight: number;
  /** Theme id — drives the live :root CSS variables. */
  themeId: string;
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  terminalFontSize: TERMINAL_DEFAULT_FONT_SIZE,
  terminalFontFamily: TERMINAL_DEFAULT_FONT_FAMILY,
  terminalLineHeight: TERMINAL_DEFAULT_LINE_HEIGHT,
  themeId: DEFAULT_THEME_ID,
};

export interface UseGlobalConfigResult {
  config: GlobalConfig;
  /** Apply a partial update; persists to disk after a 250ms debounce. */
  update: (partial: Partial<GlobalConfig>) => void;
  /** True until the initial read from disk completes. */
  loaded: boolean;
}

const PERSIST_DEBOUNCE_MS = 250;

/** Convert the disk payload (snake_case + nullable) to a fully-resolved config. */
function payloadToConfig(payload: GlobalConfigPayload | null | undefined): GlobalConfig {
  return {
    terminalFontSize:
      typeof payload?.terminal_font_size === 'number'
        ? payload.terminal_font_size
        : DEFAULT_GLOBAL_CONFIG.terminalFontSize,
    terminalFontFamily:
      typeof payload?.terminal_font_family === 'string' && payload.terminal_font_family.length > 0
        ? payload.terminal_font_family
        : DEFAULT_GLOBAL_CONFIG.terminalFontFamily,
    terminalLineHeight:
      typeof payload?.terminal_line_height === 'number'
        ? payload.terminal_line_height
        : DEFAULT_GLOBAL_CONFIG.terminalLineHeight,
    themeId:
      typeof payload?.theme_id === 'string' && payload.theme_id.length > 0
        ? payload.theme_id
        : DEFAULT_GLOBAL_CONFIG.themeId,
  };
}

/** Convert the in-memory config to the disk payload (snake_case keys). */
function configToPayload(config: GlobalConfig): GlobalConfigPayload {
  return {
    terminal_font_size: config.terminalFontSize,
    terminal_font_family: config.terminalFontFamily,
    terminal_line_height: config.terminalLineHeight,
    theme_id: config.themeId,
  };
}

export function useGlobalConfig(): UseGlobalConfigResult {
  const [config, setConfig] = useState<GlobalConfig>(DEFAULT_GLOBAL_CONFIG);
  const [loaded, setLoaded] = useState(false);

  // The most recent in-memory value, used by the debounced flush so it
  // always writes the latest values without depending on `config` directly
  // (which would tear down/restart the timer on every keystroke).
  const latestRef = useRef<GlobalConfig>(DEFAULT_GLOBAL_CONFIG);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load once on mount.
  useEffect(() => {
    let cancelled = false;
    console.debug('[Deepthix][useGlobalConfig] loading from disk');
    cmdReadGlobalConfig()
      .then((payload) => {
        if (cancelled) return;
        const resolved = payloadToConfig(payload);
        console.info('[Deepthix][useGlobalConfig] loaded', resolved);
        latestRef.current = resolved;
        applyTheme(resolved.themeId);
        applyAppFont(resolved.terminalFontFamily);
        setConfig(resolved);
        setLoaded(true);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][useGlobalConfig] read failed; using defaults', msg);
        latestRef.current = DEFAULT_GLOBAL_CONFIG;
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Flush pending writes if the consumer unmounts (e.g. app closes mid-debounce).
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
        // Best-effort final flush — fire-and-forget.
        const payload = configToPayload(latestRef.current);
        console.debug('[Deepthix][useGlobalConfig] unmount flush', payload);
        void cmdWriteGlobalConfig(payload).catch((err) => {
          console.error('[Deepthix][useGlobalConfig] unmount flush failed', err);
        });
      }
    };
  }, []);

  const update = useCallback((partial: Partial<GlobalConfig>): void => {
    console.debug('[Deepthix][useGlobalConfig] update', partial);
    setConfig((prev) => {
      const next: GlobalConfig = { ...prev, ...partial };
      latestRef.current = next;
      if (partial.themeId && partial.themeId !== prev.themeId) {
        applyTheme(next.themeId);
      }
      if (partial.terminalFontFamily && partial.terminalFontFamily !== prev.terminalFontFamily) {
        applyAppFont(next.terminalFontFamily);
      }
      return next;
    });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      const payload = configToPayload(latestRef.current);
      console.debug('[Deepthix][useGlobalConfig] debounced flush', payload);
      void cmdWriteGlobalConfig(payload).catch((err) => {
        console.error('[Deepthix][useGlobalConfig] persist failed', err);
      });
    }, PERSIST_DEBOUNCE_MS);
  }, []);

  return useMemo(() => ({ config, update, loaded }), [config, update, loaded]);
}
