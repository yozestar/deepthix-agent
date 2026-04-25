// Square pixel dot used everywhere a session/project status indicator is
// shown (sub-tabs, sidebar, overview cards, ball overlays). No animation —
// the colour just toggles between green (working), red (idle), or
// transparent (absent / no agents).
//
// Stays a simple inline-block so callers can drop it inline next to text
// without worrying about layout reflow.

import type { AgentStatus } from '../hooks/useAgentStatus';

interface Props {
  status: AgentStatus;
  /** Pixel size of the dot's bounding box. Defaults to 8px. */
  size?: number;
  /** Optional title (tooltip) for accessibility. */
  title?: string;
}

export function StatusDot({ status, size = 8, title }: Props): React.JSX.Element {
  const background =
    status === 'working'
      ? 'var(--color-status-success)'
      : status === 'idle'
        ? 'var(--color-danger)'
        : 'transparent';
  return (
    <span
      title={title ?? status}
      aria-label={title ?? `status: ${status}`}
      style={{
        display: 'inline-block',
        width: `${size}px`,
        height: `${size}px`,
        background,
        border: '1px solid var(--color-border)',
        flexShrink: 0,
        // No border-radius — square pixel aesthetic.
      }}
    />
  );
}
