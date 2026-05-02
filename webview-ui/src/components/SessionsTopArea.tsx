/* eslint-disable deepthix/no-inline-colors */
// Top half of the SESSIONS view. Hosts the project-level Coach
// (Sonnet sub-session that watches every claude session in the
// project and proposes improvements every 10 min when ON).

import { useMemo } from 'react';

import type { TerminalEntry } from '../hooks/useTerminals';
import { CoachPane } from './CoachPane';

interface Props {
  /** All terminals visible for the active project. */
  visibleTerminals: TerminalEntry[];
  /** Active project id — drives the coach's persisted state file. */
  activeProjectId: string | null;
  /** Active project's working directory — coach is spawned there. */
  activeProjectPath: string | null;
}

export function SessionsTopArea({
  visibleTerminals,
  activeProjectId,
  activeProjectPath,
}: Props): React.JSX.Element {
  // Filter to claude sessions that already learned their UUID. The
  // coach reads each session's JSONL by stable session_id; sessions
  // mid-spawn (no init event yet) are skipped until they're ready.
  const sessions = useMemo(
    () =>
      visibleTerminals
        .filter((t) => t.kind === 'claude' && t.sessionId)
        .map((t) => ({ sessionId: t.sessionId as string, label: t.label })),
    [visibleTerminals],
  );

  if (!activeProjectId || !activeProjectPath) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-pixel)',
          fontSize: 12,
          opacity: 0.6,
        }}
      >
        Open a project to enable the Coach.
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
        // Re-mount on project switch so the coach state is loaded
        // for the new project.
        key={activeProjectId}
        projectId={activeProjectId}
        cwd={activeProjectPath}
        sessions={sessions}
      />
    </div>
  );
}
