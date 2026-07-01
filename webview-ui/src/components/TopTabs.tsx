// Top header bar for the right pane: project name on the left, mode tabs
// (Overview / Sessions / Files / Process / Memory) on the right. The active
// mode controls which content App.tsx mounts in the rest of the right pane.
//
// `'settings'` is part of the `Mode` union but intentionally NOT shown in
// the top tab strip — the SETTINGS button at the top of the sidebar
// switches into it instead.

export type Mode =
  | 'overview'
  | 'sessions'
  | 'process'
  | 'memory'
  | 'files'
  | 'usage'
  | 'skills'
  | 'schedule'
  | 'workflow'
  | 'variables'
  | 'settings';

interface Props {
  projectName: string | null;
  mode: Mode;
  onChangeMode: (m: Mode) => void;
}

/** Visible top-tab modes, in display order. `'settings'` is filtered out.
 *  FILES and USAGE live here (moved out of the left sidebar per user
 *  request — the sidebar is now the projects-only scroll column). */
const VISIBLE_MODES: ReadonlyArray<Mode> = [
  'overview',
  'sessions',
  'files',
  'usage',
  'process',
  'memory',
  'skills',
  'schedule',
  'workflow',
  'variables',
];

export function TopTabs({ projectName, mode, onChangeMode }: Props): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '6px 12px',
        background: 'var(--color-bg-dark)',
        borderBottom: '2px solid var(--color-border)',
        fontFamily: 'var(--font-pixel)',
        flexShrink: 0,
        minHeight: '44px',
      }}
    >
      {/* Left: project name. No more heavy box — just a clean label with a
          discrete "▸" path hint on hover. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '8px',
          padding: '4px 8px',
          fontSize: '15px',
          letterSpacing: '0.04em',
          maxWidth: '50%',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          fontWeight: 'bold',
          color: 'var(--color-text)',
        }}
        title={projectName ?? 'Deepthix Agent'}
      >
        <span style={{ color: 'var(--color-accent)' }}>▸</span>
        <span>{projectName ?? 'Deepthix Agent'}</span>
      </div>

      {/* Right: mode tabs. Active tab gets an underline-style accent
          instead of full-fill — calmer chrome. */}
      <div style={{ display: 'flex', gap: '2px' }}>
        {VISIBLE_MODES.map((m) => {
          const active = m === mode;
          return (
            <button
              key={m}
              type="button"
              onClick={() => {
                console.debug('[Deepthix][TopTabs] mode ->', m);
                onChangeMode(m);
              }}
              style={{
                padding: '6px 12px',
                background: active ? 'var(--color-bg)' : 'transparent',
                color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
                border: 'none',
                borderBottom: `2px solid ${active ? 'var(--color-accent)' : 'transparent'}`,
                cursor: 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '12px',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontWeight: active ? 'bold' : 'normal',
                transition: 'color 120ms ease, border-color 120ms ease, background 120ms ease',
              }}
              onMouseEnter={(e) => {
                if (!active) (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text)';
              }}
              onMouseLeave={(e) => {
                if (!active)
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)';
              }}
              title={`Switch to ${m} mode`}
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}
