/* eslint-disable deepthix/no-inline-colors */
// Top half of the SESSIONS view. Hosts the GLOBAL Coach (Sonnet
// sub-session that watches every claude session in EVERY project and
// proposes improvements every 10 min when ON). One coach for the whole
// app — flipping ON in any project means ON for every project.

import { useEffect, useMemo, useState } from 'react';

import type { TerminalEntry } from '../hooks/useTerminals';
import type { Project } from '../tauri/types';
import { CoachPane } from './CoachPane';

/** localStorage key — persists "coach pane hidden" across reloads so
 *  the user doesn't have to re-hide every restart. Stored as the
 *  string "1" when hidden, absent otherwise. */
const COACH_HIDDEN_KEY = 'deepthix.coach.hidden';

interface Props {
  /** EVERY terminal across every project — the coach is global so it
   *  needs the whole list, not just the active project's slice. */
  allTerminals: TerminalEntry[];
  /** Project list — used to resolve project name + cwd from each
   *  session's projectId. */
  projects: Project[];
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

  const [hidden, setHidden] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem(COACH_HIDDEN_KEY) === '1',
  );
  useEffect(() => {
    function syncFromStorage(): void {
      setHidden(window.localStorage.getItem(COACH_HIDDEN_KEY) === '1');
    }
    window.addEventListener('storage', syncFromStorage);
    return () => window.removeEventListener('storage', syncFromStorage);
  }, []);

  if (hidden) {
    return (
      <div
        style={{
          padding: '4px 12px',
          background: 'var(--color-bg-dark)',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          fontFamily: 'var(--font-pixel)',
          fontSize: '0.6875rem',
          color: 'var(--color-text-muted)',
        }}
      >
        <button
          type="button"
          onClick={() => {
            window.localStorage.removeItem(COACH_HIDDEN_KEY);
            setHidden(false);
          }}
          className="dt-btn"
          style={{
            padding: '2px 10px',
            fontSize: '0.6875rem',
            cursor: 'pointer',
          }}
          title="Réafficher le panneau Coach"
        >
          👁 Afficher coach
        </button>
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
        sessions={sessions}
        onHide={() => {
          window.localStorage.setItem(COACH_HIDDEN_KEY, '1');
          setHidden(true);
        }}
      />
    </div>
  );
}
