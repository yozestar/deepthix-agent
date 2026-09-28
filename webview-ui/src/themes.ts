/* eslint-disable deepthix/no-inline-colors */
// Color theme presets. Each theme overrides the :root CSS custom properties
// at runtime by writing to document.documentElement.style.

export interface Theme {
  id: string;
  name: string;
  /** Light themes flip `color-scheme` so native widgets (scrollbars,
   *  date pickers, autofill) match. Defaults to dark. */
  scheme?: 'dark' | 'light';
  /** Map of CSS variable name (without leading `--`) to value. */
  colors: Record<string, string>;
}

/** Pseudo-theme: follows the OS light/dark setting live, resolving to
 *  the two "Moderne" palettes below. */
export const SYSTEM_THEME_ID = 'system';
const SYSTEM_DARK_ID = 'moderne-sombre';
const SYSTEM_LIGHT_ID = 'moderne-clair';

export const THEMES: Theme[] = [
  {
    // Calm slate palette, low glare, soft blue accent. Default for new
    // installs — made for long reading sessions.
    id: 'moderne-sombre',
    name: 'Moderne sombre',
    colors: {
      'color-bg': '#1b1f27',
      'color-bg-dark': '#161a21',
      'color-bg-session': '#1f242d',
      'color-bg-thumb': '#262c36',
      'color-border': '#333b48',
      'color-accent': '#7aa2f7',
      'color-accent-bright': '#9bb8fa',
      'color-session-active': '#5ec4a8',
      'color-text': '#d7dce4',
      'color-text-muted': 'rgba(215, 220, 228, 0.55)',
      'color-btn-bg': '#242a34',
      'color-btn-hover': '#2d3440',
      'color-active-bg': '#2f3a4f',
      'color-danger': '#e5747c',
      'color-warning': '#e2b86b',
      'color-status-success': '#8cc98f',
      'shadow-hard': '2px 2px 0px #0d1015',
    },
  },
  {
    // Paper-white daytime palette. Chrome (sidebar / top bar) sits one
    // step darker than the conversation so the reading area stays the
    // brightest, calmest surface.
    id: 'moderne-clair',
    name: 'Moderne clair',
    scheme: 'light',
    colors: {
      'color-bg': '#f6f7f9',
      'color-bg-dark': '#eceef2',
      'color-bg-session': '#ffffff',
      'color-bg-thumb': '#e4e7ec',
      'color-border': '#d5d9e0',
      'color-accent': '#3b6fd8',
      'color-accent-bright': '#5584e6',
      'color-session-active': '#0f9d7a',
      'color-text': '#1f2530',
      'color-text-muted': 'rgba(31, 37, 48, 0.58)',
      'color-btn-bg': '#e8ebf0',
      'color-btn-hover': '#dde2ea',
      'color-active-bg': '#dbe6fb',
      'color-danger': '#d0454f',
      'color-warning': '#c77d12',
      'color-status-success': '#2f8f4e',
      'color-status-permission': '#a67c00',
      'shadow-hard': '2px 2px 0px #c9ced8',
    },
  },
  {
    id: 'pixel-default',
    name: 'Pixel Default',
    colors: {
      'color-bg': '#1e1e2e',
      'color-bg-dark': '#181828',
      // Slight uplift over --color-bg used as the chat-session "stage"
      // background so the focus zone visually pops out of the chrome
      // (sidebar / top tabs / header all sit on --color-bg-dark; main
      // content uses --color-bg; the active chat pane uses this).
      'color-bg-session': '#252539',
      'color-bg-thumb': '#2a2a3a',
      'color-border': '#4a4a6a',
      'color-accent': '#6030ff',
      'color-accent-bright': '#746fff',
      // Distinct hue from --color-accent so "the pane I'm actively
      // talking to" is identifiable at a glance (60-30-10 wayfinding +
      // tmux convention: active pane border = different colour).
      'color-session-active': '#00d4aa',
      'color-text': 'rgba(255, 255, 255, 0.9)',
      'color-text-muted': 'rgba(255, 255, 255, 0.5)',
      'color-btn-bg': 'rgb(53, 52, 69)',
      'color-btn-hover': 'rgb(78, 75, 104)',
      'color-active-bg': 'rgb(44, 43, 109)',
      'color-danger': '#d14249',
      'color-warning': '#ff8d14',
      'color-status-success': '#89d185',
      'shadow-hard': '2px 2px 0px #0a0a14',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    colors: {
      'color-bg': '#282a36',
      'color-bg-dark': '#1e1f29',
      'color-bg-session': '#32344a',
      'color-bg-thumb': '#3a3c4a',
      'color-border': '#6272a4',
      'color-accent': '#bd93f9',
      'color-accent-bright': '#d6acff',
      'color-session-active': '#8be9fd',
      'color-text': '#f8f8f2',
      'color-text-muted': 'rgba(248, 248, 242, 0.6)',
      'color-btn-bg': '#44475a',
      'color-btn-hover': '#6272a4',
      'color-active-bg': '#44475a',
      'color-danger': '#ff5555',
      'color-warning': '#ffb86c',
      'color-status-success': '#50fa7b',
      'shadow-hard': '2px 2px 0px #14151c',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    colors: {
      'color-bg': '#2e3440',
      'color-bg-dark': '#242933',
      'color-bg-session': '#383f4f',
      'color-bg-thumb': '#3b4252',
      'color-border': '#4c566a',
      'color-accent': '#88c0d0',
      'color-accent-bright': '#8fbcbb',
      'color-session-active': '#ebcb8b',
      'color-text': '#eceff4',
      'color-text-muted': 'rgba(236, 239, 244, 0.6)',
      'color-btn-bg': '#3b4252',
      'color-btn-hover': '#434c5e',
      'color-active-bg': '#5e81ac',
      'color-danger': '#bf616a',
      'color-warning': '#ebcb8b',
      'color-status-success': '#a3be8c',
      'shadow-hard': '2px 2px 0px #1a1d24',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    colors: {
      'color-bg': '#1a1b26',
      'color-bg-dark': '#16161e',
      'color-bg-session': '#20212e',
      'color-bg-thumb': '#24283b',
      'color-border': '#414868',
      'color-accent': '#7aa2f7',
      'color-accent-bright': '#bb9af7',
      'color-session-active': '#2ac3de',
      'color-text': '#c0caf5',
      'color-text-muted': 'rgba(192, 202, 245, 0.55)',
      'color-btn-bg': '#1f2335',
      'color-btn-hover': '#2a2e45',
      'color-active-bg': '#3d59a1',
      'color-danger': '#f7768e',
      'color-warning': '#e0af68',
      'color-status-success': '#9ece6a',
      'shadow-hard': '2px 2px 0px #0c0d12',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    colors: {
      'color-bg': '#1e1e2e',
      'color-bg-dark': '#181825',
      'color-bg-session': '#25253a',
      'color-bg-thumb': '#313244',
      'color-border': '#45475a',
      'color-accent': '#cba6f7',
      'color-accent-bright': '#f5c2e7',
      'color-session-active': '#94e2d5',
      'color-text': '#cdd6f4',
      'color-text-muted': 'rgba(205, 214, 244, 0.55)',
      'color-btn-bg': '#313244',
      'color-btn-hover': '#45475a',
      'color-active-bg': '#585b70',
      'color-danger': '#f38ba8',
      'color-warning': '#fab387',
      'color-status-success': '#a6e3a1',
      'shadow-hard': '2px 2px 0px #11111b',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    colors: {
      'color-bg': '#282828',
      'color-bg-dark': '#1d2021',
      'color-bg-session': '#32302f',
      'color-bg-thumb': '#3c3836',
      'color-border': '#665c54',
      'color-accent': '#fabd2f',
      'color-accent-bright': '#fe8019',
      'color-session-active': '#83a598',
      'color-text': '#ebdbb2',
      'color-text-muted': 'rgba(235, 219, 178, 0.55)',
      'color-btn-bg': '#3c3836',
      'color-btn-hover': '#504945',
      'color-active-bg': '#665c54',
      'color-danger': '#fb4934',
      'color-warning': '#fe8019',
      'color-status-success': '#b8bb26',
      'shadow-hard': '2px 2px 0px #0a0a0a',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    colors: {
      'color-bg': '#272822',
      'color-bg-dark': '#1d1e19',
      'color-bg-session': '#2f2f28',
      'color-bg-thumb': '#3e3d32',
      'color-border': '#75715e',
      'color-accent': '#f92672',
      'color-accent-bright': '#fd5fbb',
      'color-session-active': '#66d9ef',
      'color-text': '#f8f8f2',
      'color-text-muted': 'rgba(248, 248, 242, 0.55)',
      'color-btn-bg': '#3e3d32',
      'color-btn-hover': '#49483e',
      'color-active-bg': '#75715e',
      'color-danger': '#f92672',
      'color-warning': '#fd971f',
      'color-status-success': '#a6e22e',
      'shadow-hard': '2px 2px 0px #14140e',
    },
  },
  {
    // Low-contrast dark palette inspired by Ayu Mirage. Designed for
    // 8h-a-day reading: muted background, desaturated sage/cyan accent
    // instead of pure violet, warm cream text instead of stark white.
    // Pairs well with the 'inter' UI font for the most eye-friendly
    // combo. See feedback_ui_readability if it exists.
    id: 'lecture-longue',
    name: 'Lecture longue',
    colors: {
      'color-bg': '#1f2430',
      'color-bg-dark': '#191e2a',
      'color-bg-session': '#242a37',
      'color-bg-thumb': '#2d333f',
      'color-border': '#3e4759',
      'color-accent': '#73d0c0',
      'color-accent-bright': '#9cdcd0',
      'color-session-active': '#dfbd72',
      'color-text': '#cbccc6',
      'color-text-muted': 'rgba(203, 204, 198, 0.55)',
      'color-btn-bg': '#2a2f3c',
      'color-btn-hover': '#363c4d',
      'color-active-bg': '#3e4759',
      'color-danger': '#e07a82',
      'color-warning': '#e6c073',
      'color-status-success': '#a3d976',
      'shadow-hard': '2px 2px 0px #11141c',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    colors: {
      'color-bg': '#002b36',
      'color-bg-dark': '#001f27',
      'color-bg-session': '#073642',
      'color-bg-thumb': '#073642',
      'color-border': '#586e75',
      'color-accent': '#268bd2',
      'color-accent-bright': '#2aa198',
      'color-session-active': '#b58900',
      'color-text': '#eee8d5',
      'color-text-muted': 'rgba(238, 232, 213, 0.55)',
      'color-btn-bg': '#073642',
      'color-btn-hover': '#586e75',
      'color-active-bg': '#268bd2',
      'color-danger': '#dc322f',
      'color-warning': '#cb4b16',
      'color-status-success': '#859900',
      'shadow-hard': '2px 2px 0px #001017',
    },
  },
];

export const DEFAULT_THEME_ID = 'moderne-sombre';

/** Every CSS variable any theme writes — cleared before applying the next
 *  theme so a key one theme sets (e.g. status-permission) doesn't leak
 *  into a theme that relies on the stylesheet default. */
const ALL_THEME_KEYS = [...new Set(THEMES.flatMap((t) => Object.keys(t.colors)))];

let systemQuery: MediaQueryList | null = null;
let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

function writeTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const key of ALL_THEME_KEYS) root.style.removeProperty(`--${key}`);
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${key}`, value);
  }
  root.style.colorScheme = theme.scheme ?? 'dark';
  root.setAttribute('data-theme-scheme', theme.scheme ?? 'dark');
}

/** Resolve a theme id to a concrete palette ('system' → light/dark per OS). */
export function resolveTheme(themeId: string, prefersDark: boolean): Theme {
  const id =
    themeId === SYSTEM_THEME_ID ? (prefersDark ? SYSTEM_DARK_ID : SYSTEM_LIGHT_ID) : themeId;
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function applyTheme(themeId: string): void {
  // Drop any previous OS listener; re-attach only for the 'system' theme.
  if (systemQuery && systemListener) systemQuery.removeEventListener('change', systemListener);
  systemQuery = null;
  systemListener = null;

  if (themeId === SYSTEM_THEME_ID && typeof window.matchMedia === 'function') {
    systemQuery = window.matchMedia('(prefers-color-scheme: dark)');
    systemListener = (e) => writeTheme(resolveTheme(SYSTEM_THEME_ID, e.matches));
    systemQuery.addEventListener('change', systemListener);
    writeTheme(resolveTheme(SYSTEM_THEME_ID, systemQuery.matches));
  } else {
    writeTheme(resolveTheme(themeId, true));
  }
  console.debug('[Deepthix][themes] applied', themeId);
}
