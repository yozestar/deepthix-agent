/* eslint-disable deepthix/no-inline-colors */
// Color theme presets. Each theme overrides the :root CSS custom properties
// at runtime by writing to document.documentElement.style.

export interface Theme {
  id: string;
  name: string;
  /** Map of CSS variable name (without leading `--`) to value. */
  colors: Record<string, string>;
}

export const THEMES: Theme[] = [
  {
    id: 'pixel-default',
    name: 'Pixel Default',
    colors: {
      'color-bg': '#1e1e2e',
      'color-bg-dark': '#181828',
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
      'shadow-pixel': '2px 2px 0px #0a0a14',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    colors: {
      'color-bg': '#282a36',
      'color-bg-dark': '#1e1f29',
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
      'shadow-pixel': '2px 2px 0px #14151c',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    colors: {
      'color-bg': '#2e3440',
      'color-bg-dark': '#242933',
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
      'shadow-pixel': '2px 2px 0px #1a1d24',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    colors: {
      'color-bg': '#1a1b26',
      'color-bg-dark': '#16161e',
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
      'shadow-pixel': '2px 2px 0px #0c0d12',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    colors: {
      'color-bg': '#1e1e2e',
      'color-bg-dark': '#181825',
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
      'shadow-pixel': '2px 2px 0px #11111b',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    colors: {
      'color-bg': '#282828',
      'color-bg-dark': '#1d2021',
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
      'shadow-pixel': '2px 2px 0px #0a0a0a',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    colors: {
      'color-bg': '#272822',
      'color-bg-dark': '#1d1e19',
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
      'shadow-pixel': '2px 2px 0px #14140e',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    colors: {
      'color-bg': '#002b36',
      'color-bg-dark': '#001f27',
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
      'shadow-pixel': '2px 2px 0px #001017',
    },
  },
];

export const DEFAULT_THEME_ID = 'pixel-default';

export function applyTheme(themeId: string): void {
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${key}`, value);
  }
  console.debug('[Deepthix][themes] applied', theme.id);
}
