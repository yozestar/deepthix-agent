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

/** UI fonts available in SETTINGS. "pixel" = the original FS Pixel Sans
 *  (charm). "inter" = the readable open-source sans-serif most product
 *  UIs use today — easier for long reading sessions because of its
 *  anti-aliasing and metrics. Bundled via @fontsource/inter so the
 *  switch works offline. */
export const UI_FONT_IDS = ['pixel', 'inter'] as const;
export type UiFontId = (typeof UI_FONT_IDS)[number];
// Default to Inter for new installs — long reading sessions on the
// pixel font caused eye fatigue. Users who prefer the original look
// can switch back via Settings → Police d'interface.
const DEFAULT_UI_FONT: UiFontId = 'inter';

/** Push the chosen UI font into --font-pixel + inject a high-priority
 *  `*` override that beats Tailwind v4's inlined @theme utility classes.
 *  xterm draws glyphs on canvas via its own JS API, so this override
 *  doesn't affect terminal rendering — only the surrounding DOM. */
function applyUiFont(font: UiFontId): void {
  const family = font === 'inter' ? "'Inter', sans-serif" : "'FS Pixel Sans', sans-serif";
  document.documentElement.style.setProperty('--font-pixel', family);
  document.documentElement.setAttribute('data-ui-font', font);
  let style = document.getElementById('deepthix-font-override') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'deepthix-font-override';
    document.head.appendChild(style);
  }
  style.textContent = `* { font-family: ${family} !important; }`;
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
  /** Box / surface style: pixel | glass | flat | soft | neon. */
  boxStyle: BoxStyleId;
  /** Hard cap on concurrent claude sessions Deepthix will spawn. Each
   *  claude process holds 200-250 MB resident, so this protects the
   *  host from accidental pile-up. Default 6, range 2-20. */
  maxActiveSessions: number;
  /** How many trailing messages each session keeps in React state.
   *  Older messages are dropped from the tree to keep typing fluid on
   *  long --resume'd sessions. Default 100, range 50-500. */
  maxMessagesPerSession: number;
  /** UI font: 'pixel' (charm) or 'inter' (lecture longue). */
  uiFont: UiFontId;
  /** Multiplier on root font-size for the whole UI (xterm not affected).
   *  Range 0.85..1.6, default 1.0. Scales rem/em-based text without
   *  touching pixel widths so the layout stays put. */
  uiTextScale: number;
}

export const BOX_STYLE_IDS = ['pixel', 'glass', 'flat', 'soft', 'neon'] as const;
export type BoxStyleId = (typeof BOX_STYLE_IDS)[number];
const DEFAULT_BOX_STYLE: BoxStyleId = 'pixel';

function applyBoxStyle(style: BoxStyleId): void {
  document.documentElement.setAttribute('data-box-style', style);
}

/** Scale every rem/em-sized text in the UI by `scale` (xterm reads its
 *  own px-based config and is unaffected). Works by changing the root
 *  font-size — does NOT use CSS `zoom`, which previously scaled chrome
 *  widths too and caused horizontal overflow (commit 1de8396). */
function applyUiTextScale(scale: number): void {
  const safe = Math.max(UI_TEXT_SCALE_MIN, Math.min(UI_TEXT_SCALE_MAX, scale));
  document.documentElement.style.fontSize = `${16 * safe}px`;
}
export const UI_TEXT_SCALE_MIN = 0.85;
export const UI_TEXT_SCALE_MAX = 1.6;
export const UI_TEXT_SCALE_DEFAULT = 1.0;
export const UI_TEXT_SCALE_STEP = 0.05;

export const MAX_ACTIVE_SESSIONS_DEFAULT = 20;
export const MAX_ACTIVE_SESSIONS_MIN = 2;
export const MAX_ACTIVE_SESSIONS_MAX = 50;
export const MAX_MESSAGES_PER_SESSION_DEFAULT = 100;
export const MAX_MESSAGES_PER_SESSION_MIN = 50;
export const MAX_MESSAGES_PER_SESSION_MAX = 500;

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  terminalFontSize: TERMINAL_DEFAULT_FONT_SIZE,
  terminalFontFamily: TERMINAL_DEFAULT_FONT_FAMILY,
  terminalLineHeight: TERMINAL_DEFAULT_LINE_HEIGHT,
  themeId: DEFAULT_THEME_ID,
  boxStyle: DEFAULT_BOX_STYLE,
  maxActiveSessions: MAX_ACTIVE_SESSIONS_DEFAULT,
  maxMessagesPerSession: MAX_MESSAGES_PER_SESSION_DEFAULT,
  uiFont: DEFAULT_UI_FONT,
  uiTextScale: UI_TEXT_SCALE_DEFAULT,
};

const clampSessions = (n: number): number =>
  Math.max(MAX_ACTIVE_SESSIONS_MIN, Math.min(MAX_ACTIVE_SESSIONS_MAX, Math.round(n)));
const clampMessages = (n: number): number =>
  Math.max(MAX_MESSAGES_PER_SESSION_MIN, Math.min(MAX_MESSAGES_PER_SESSION_MAX, Math.round(n)));

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
    boxStyle:
      typeof payload?.box_style === 'string' &&
      (BOX_STYLE_IDS as readonly string[]).includes(payload.box_style)
        ? (payload.box_style as BoxStyleId)
        : DEFAULT_GLOBAL_CONFIG.boxStyle,
    maxActiveSessions:
      typeof payload?.max_active_sessions === 'number'
        ? clampSessions(payload.max_active_sessions)
        : DEFAULT_GLOBAL_CONFIG.maxActiveSessions,
    maxMessagesPerSession:
      typeof payload?.max_messages_per_session === 'number'
        ? clampMessages(payload.max_messages_per_session)
        : DEFAULT_GLOBAL_CONFIG.maxMessagesPerSession,
    uiFont:
      typeof payload?.ui_font === 'string' &&
      (UI_FONT_IDS as readonly string[]).includes(payload.ui_font)
        ? (payload.ui_font as UiFontId)
        : DEFAULT_GLOBAL_CONFIG.uiFont,
    uiTextScale:
      typeof payload?.ui_text_scale === 'number'
        ? Math.max(UI_TEXT_SCALE_MIN, Math.min(UI_TEXT_SCALE_MAX, payload.ui_text_scale))
        : DEFAULT_GLOBAL_CONFIG.uiTextScale,
  };
}

/** Convert the in-memory config to the disk payload (snake_case keys). */
function configToPayload(config: GlobalConfig): GlobalConfigPayload {
  return {
    terminal_font_size: config.terminalFontSize,
    terminal_font_family: config.terminalFontFamily,
    terminal_line_height: config.terminalLineHeight,
    theme_id: config.themeId,
    box_style: config.boxStyle,
    max_active_sessions: config.maxActiveSessions,
    max_messages_per_session: config.maxMessagesPerSession,
    ui_font: config.uiFont,
    ui_text_scale: config.uiTextScale,
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
        applyUiFont(resolved.uiFont);
        applyUiTextScale(resolved.uiTextScale);
        applyBoxStyle(resolved.boxStyle);
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
      // terminalFontFamily no longer touches the DOM — xterm reads it
      // directly via its canvas API (TerminalTab.tsx).
      if (partial.uiFont && partial.uiFont !== prev.uiFont) {
        applyUiFont(next.uiFont);
      }
      if (
        typeof partial.uiTextScale === 'number' &&
        partial.uiTextScale !== prev.uiTextScale
      ) {
        applyUiTextScale(next.uiTextScale);
      }
      if (partial.boxStyle && partial.boxStyle !== prev.boxStyle) {
        applyBoxStyle(next.boxStyle);
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
