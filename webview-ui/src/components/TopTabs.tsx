// Top header bar for the right pane: project name on the left, mode tabs
// (Overview / Sessions / Files / Process / Memory) on the right. The active
// mode controls which content App.tsx mounts in the rest of the right pane.
//
// `'settings'` is part of the `Mode` union but intentionally NOT shown in
// the top tab strip — the SETTINGS button at the top of the sidebar
// switches into it instead.

export type Mode = 'overview' | 'sessions' | 'process' | 'memory' | 'files' | 'skills' | 'settings';

interface Props {
  projectName: string | null;
  mode: Mode;
  onChangeMode: (m: Mode) => void;
}

/** Visible top-tab modes, in display order. `'settings'` is filtered out. */
const VISIBLE_MODES: ReadonlyArray<Mode> = [
  'overview',
  'sessions',
  'files',
  'process',
  'memory',
  'skills',
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
      {/* Left: project name badge (replaces the floating badge that used to
          live inside the tamagotchi). Falls back to the app name when no
          project is selected. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 12px',
          background: 'var(--color-bg)',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          fontSize: '15px',
          letterSpacing: '0.05em',
          maxWidth: '50%',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
        title={projectName ?? 'Deepthix Agent'}
      >
        <span style={{ opacity: 0.85 }}>{projectName ?? 'Deepthix Agent'}</span>
      </div>

      {/* Right: mode tabs */}
      <div style={{ display: 'flex', gap: '6px' }}>
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
                padding: '6px 14px',
                background: active ? 'var(--color-accent)' : 'transparent',
                color: active ? 'var(--color-bg-dark)' : 'inherit',
                border: '2px solid var(--color-border)',
                boxShadow: active ? 'var(--shadow-pixel)' : 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '13px',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
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
