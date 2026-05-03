/* eslint-disable deepthix/no-inline-colors */
// Top half of the SESSIONS view. Hosts the GLOBAL Coach (Sonnet
// sub-session that watches every claude session in EVERY project and
// proposes improvements every 10 min when ON). One coach for the whole
// app — flipping ON in any project means ON for every project.

import { useMemo } from 'react';

import type { ProjectInfo } from '../tauri/commands';
import type { TerminalEntry } from '../hooks/useTerminals';
import { CoachPane } from './CoachPane';

interface Props {
  /** EVERY terminal across every project — the coach is global so it
   *  needs the whole list, not just the active project's slice. */
  allTerminals: TerminalEntry[];
  /** Project list — used to resolve project name + cwd from each
   *  session's projectId. */
  projects: ProjectInfo[];
}

export function SessionsTopArea({
  allTerminals,
  projects,
}: Props): React.JSX.Element {
  // Filter to claude sessions that already learned their UUID, then
  // join project metadata so the coach can read each one's JSONL.
  const sessions = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    return allTerminals
      .filter((t) => t.kind === 'claude' && t.sessionId && byId.has(t.projectId))
      .map((t) => {
        const p = byId.get(t.projectId);
        return {
          sessionId: t.sessionId as string,
          label: t.label,
          cwd: p?.path ?? '',
          projectName: p?.name ?? t.projectId,
          projectId: t.projectId,
        };
      });
  }, [allTerminals, projects]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <CoachPane sessions={sessions} />
    </div>
  );
}
