// Cross-project agent overview (Phase 11). Lists ALL claude sessions across
// every project, grouped by project, with their current working/idle status.
// Click a card → switch to that project + activate that session + flip the
// top-tab to SESSIONS.
//
// Updates automatically as sessions appear, get renamed, get closed, or
// change tool-use state — driven by `useAgentStatus` which subscribes to
// the same `agentToolStart`/`agentToolDone`/`agentToolClear` window events
// the office canvas uses.

import { useMemo } from 'react';

import { useAgentStatus } from '../hooks/useAgentStatus';
import type { UseProjectsResult } from '../hooks/useProjects';
import type { TerminalEntry, UseTerminalsResult } from '../hooks/useTerminals';
import { PixelBrain } from './PixelBrain';
import { StatusDot } from './StatusDot';
import type { Mode } from './TopTabs';

interface Props {
  terminals: UseTerminalsResult;
  projects: UseProjectsResult;
  /** Switch the top mode tab — invoked when the user picks a session card. */
  onChangeMode: (m: Mode) => void;
}

interface ProjectGroup {
  projectId: string;
  projectName: string;
  projectPath: string;
  sessions: TerminalEntry[];
}

export function OverviewPane({ terminals, projects, onChangeMode }: Props): React.JSX.Element {
  const agentStatus = useAgentStatus();

  // Group every claude session by projectId, in projects-list order so the
  // layout matches the sidebar.
  const groups = useMemo<ProjectGroup[]>(() => {
    const out: ProjectGroup[] = [];
    for (const p of projects.projects) {
      const sessions = terminals.terminals.filter(
        (t) => t.projectId === p.id && t.kind === 'claude',
      );
      if (sessions.length === 0) continue;
      out.push({ projectId: p.id, projectName: p.name, projectPath: p.path, sessions });
    }
    // Also surface sessions whose project is no longer registered (rare —
    // happens if you remove a project while a terminal is still alive). Group
    // them under a synthetic "Orphaned" bucket so users can still click in.
    const knownIds = new Set(projects.projects.map((p) => p.id));
    const orphans = terminals.terminals.filter(
      (t) => t.kind === 'claude' && !knownIds.has(t.projectId),
    );
    if (orphans.length > 0) {
      out.push({
        projectId: '__orphans__',
        projectName: '(removed projects)',
        projectPath: '',
        sessions: orphans,
      });
    }
    return out;
  }, [projects.projects, terminals.terminals]);

  const totalSessions = useMemo(
    () => groups.reduce((acc, g) => acc + g.sessions.length, 0),
    [groups],
  );

  const onPickSession = (t: TerminalEntry): void => {
    console.info('[Deepthix][OverviewPane] jump to session', {
      projectId: t.projectId,
      termId: t.id,
    });
    if (t.projectId !== projects.activeProjectId && t.projectId !== '__orphans__') {
      void projects.switchProject(t.projectId);
    }
    terminals.setActive(t.id);
    onChangeMode('sessions');
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        background: 'var(--color-bg)',
        padding: '20px 24px',
        overflow: 'auto',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '16px',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: '15px', letterSpacing: '0.06em' }}>OVERVIEW</span>
          <span style={{ fontSize: '12px', opacity: 0.6 }}>
            All claude sessions across every open project.
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px' }}>
          <span style={{ opacity: 0.7 }}>
            {totalSessions} session{totalSessions === 1 ? '' : 's'}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <StatusDot status="idle" /> idle
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <StatusDot status="working" /> working
          </span>
        </div>
      </div>

      {totalSessions === 0 ? (
        <div
          style={{
            padding: '40px 12px',
            border: '2px dashed var(--color-border)',
            background: 'var(--color-bg-dark)',
            textAlign: 'center',
            fontSize: '14px',
            opacity: 0.7,
            lineHeight: 1.6,
          }}
        >
          No sessions anywhere yet.
          <br />
          Open a project from the sidebar and click <strong>+ Session</strong> to spawn one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {groups.map((g) => (
            <ProjectGroupView
              key={g.projectId}
              group={g}
              isActive={g.projectId === projects.activeProjectId}
              status={agentStatus.status}
              onPickSession={onPickSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Project group → header + grid of session cards
// ─────────────────────────────────────────────────────────────────────────

interface GroupViewProps {
  group: ProjectGroup;
  isActive: boolean;
  status: ReturnType<typeof useAgentStatus>['status'];
  onPickSession: (t: TerminalEntry) => void;
}

function ProjectGroupView({
  group,
  isActive,
  status,
  onPickSession,
}: GroupViewProps): React.JSX.Element {
  const anyWorking = group.sessions.some((s) => status(s.agentId) === 'working');
  const projectStatus = anyWorking ? 'working' : 'idle';

  return (
    <div
      style={{
        background: 'var(--color-bg)',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      {/* Project header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          borderBottom: '2px solid var(--color-border)',
          paddingBottom: '8px',
        }}
      >
        <StatusDot status={projectStatus} />
        <span
          style={{
            fontSize: '14px',
            letterSpacing: '0.06em',
            color: isActive ? 'var(--color-accent-bright)' : 'inherit',
          }}
        >
          {group.projectName}
        </span>
        {group.projectPath && (
          <span
            style={{
              fontSize: '11px',
              opacity: 0.5,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
            title={group.projectPath}
          >
            {group.projectPath}
          </span>
        )}
        <span style={{ fontSize: '12px', opacity: 0.6 }}>
          {group.sessions.length} session{group.sessions.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Brain cards grid — seed matches TamagotchiView (`projectId#idx`) so
          colors stay consistent across panes. Label is the PROJECT name (per
          user request) instead of the session label. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: '12px',
        }}
      >
        {group.sessions.map((s, idx) => (
          <SessionCard
            key={s.id}
            terminal={s}
            seed={`${s.projectId}#${idx}`}
            projectName={group.projectName}
            status={status(s.agentId)}
            onClick={() => onPickSession(s)}
          />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Single session card
// ─────────────────────────────────────────────────────────────────────────

interface CardProps {
  terminal: TerminalEntry;
  /** Stable color/look hash — matches the brain in TamagotchiView. */
  seed: string;
  /** Shown as the card label (replaces the session label per user request). */
  projectName: string;
  status: 'idle' | 'working' | 'absent';
  onClick: () => void;
}

const BRAIN_SIZE = 88;

function SessionCard({
  terminal,
  seed,
  projectName,
  status,
  onClick,
}: CardProps): React.JSX.Element {
  const active = status === 'working';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        cursor: 'pointer',
        padding: '12px 10px',
        background: active ? 'var(--color-bg-dark)' : 'transparent',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px',
        fontFamily: 'var(--font-pixel)',
        position: 'relative',
      }}
      title={`${projectName} — ${terminal.label} (click to focus)`}
    >
      {/* Status dot pinned top-right so it doesn't compete with the brain. */}
      <div style={{ position: 'absolute', top: 6, right: 6 }}>
        <StatusDot status={status} title={status} />
      </div>

      <PixelBrain seed={seed} size={BRAIN_SIZE} active={active} />

      <span
        style={{
          fontSize: '13px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '100%',
          textAlign: 'center',
        }}
      >
        {projectName}
      </span>
    </div>
  );
}
