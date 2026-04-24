// Top header bar for the right pane: project name on the left, mode tabs
// (Sessions / Browser / Process / Memory) on the right. The active mode
// controls which content App.tsx mounts in the rest of the right pane.

export type Mode = 'sessions' | 'browser' | 'process' | 'memory';

interface Props {
  projectName: string | null;
  mode: Mode;
  onChangeMode: (m: Mode) => void;
}

const MODES: ReadonlyArray<Mode> = ['sessions', 'browser', 'process', 'memory'];

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
          fontSize: '13px',
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
        {MODES.map((m) => {
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
                fontSize: '11px',
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
