/* eslint-disable deepthix/no-inline-colors */
// Top half of the SESSIONS view. Used to show a TamagotchiView with
// pixel brains bouncing around — purely decorative cruft from the
// pixel-agents fork that the user said served no purpose. We now
// host the Coach (Sonnet sub-session that analyses the active main
// session in real time) here instead.
//
// The Coach is bound to whichever claude session is currently active
// in the visible project; when the user switches sessions the Coach
// swaps along. When no claude session exists yet, we show a
// placeholder.

import type { TerminalEntry } from '../hooks/useTerminals';
import { CoachPane } from './CoachPane';

interface Props {
  /** All terminals visible for the active project. */
  visibleTerminals: TerminalEntry[];
  /** Globally-active terminal id (last clicked). */
  activeTermId: string | null;
}

export function SessionsTopArea({
  visibleTerminals,
  activeTermId,
}: Props): React.JSX.Element {
  // Pick the claude session this Coach should target. Same picker
  // logic VoiceRecorder uses: prefer the globally-active term if it's
  // a claude session in the visible project, else the first claude
  // session in the project.
  const claudeTerms = visibleTerminals.filter((t) => t.kind === 'claude');
  const target =
    claudeTerms.find((t) => t.id === activeTermId) ?? claudeTerms[0] ?? null;

  if (!target) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
          textAlign: 'center',
          fontFamily: 'var(--font-pixel)',
          color: 'var(--color-text)',
          opacity: 0.7,
        }}
      >
        <div style={{ fontSize: 14, marginBottom: 8 }}>
          No claude session yet for this project.
        </div>
        <div style={{ fontSize: 11, opacity: 0.7, maxWidth: 360 }}>
          Click <strong>+ Session</strong> below to spawn one. The Coach (Sonnet) will appear here
          as soon as a session exists; it watches the conversation live and proposes improvements.
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <CoachPane
        // key on session id so switching active session remounts the
        // Coach with the right main session id (its localStorage key
        // is also keyed by main session id).
        key={target.sessionId ?? target.id}
        cwd={target.cwd}
        mainSessionId={target.sessionId}
      />
    </div>
  );
}
