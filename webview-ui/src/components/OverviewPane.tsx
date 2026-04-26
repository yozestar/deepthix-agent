// Cross-project agent overview (Phase 11). Lists ALL claude sessions across
// every project, grouped by project, with their current working/idle status.
// Click a card → switch to that project + activate that session + flip the
// top-tab to SESSIONS.
//
// Updates automatically as sessions appear, get renamed, get closed, or
// change tool-use state — driven by `useAgentStatus` which subscribes to
// the same `agentToolStart`/`agentToolDone`/`agentToolClear` window events
// the office canvas uses.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useAgentStatus } from '../hooks/useAgentStatus';
import type { UseProjectsResult } from '../hooks/useProjects';
import type { TerminalEntry, UseTerminalsResult } from '../hooks/useTerminals';
import { dashboardMtimeMs, readSessionDashboard } from '../tauri/commands';
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

  // Only show the ACTIVE project's sessions (per user request: clicking
  // OVERVIEW from the sidebar should mean "tell me about THIS project",
  // not "show me everything everywhere"). The cross-project flat view is
  // gone — there's nothing else here.
  const groups = useMemo<ProjectGroup[]>(() => {
    const activeId = projects.activeProjectId;
    if (!activeId) return [];
    const active = projects.projects.find((p) => p.id === activeId);
    if (!active) return [];
    const sessions = terminals.terminals.filter(
      (t) => t.projectId === activeId && t.kind === 'claude',
    );
    if (sessions.length === 0) return [];
    return [
      { projectId: active.id, projectName: active.name, projectPath: active.path, sessions },
    ];
  }, [projects.activeProjectId, projects.projects, terminals.terminals]);

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
            Sessions claude du projet actif.
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
          Aucune session pour ce projet.
          <br />
          Clique sur <strong>+ Session</strong> dans la sidebar pour en créer une.
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

      {/* Cards avec iframe pleine largeur. Une seule colonne quand il n'y
          a qu'une session, sinon 2 colonnes max — l'iframe a besoin de
          place pour qu'on lise vraiment le dashboard. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            group.sessions.length === 1 ? '1fr' : 'repeat(auto-fill, minmax(520px, 1fr))',
          gap: '16px',
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

const BRAIN_SIZE = 56;
/** How often we poll the dashboard file's mtime. Cheap call (just stat). */
const DASHBOARD_POLL_MS = 2_000;

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
      style={{
        padding: '12px',
        background: active ? 'var(--color-bg-dark)' : 'transparent',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        fontFamily: 'var(--font-pixel)',
        position: 'relative',
      }}
      title={`${projectName} — ${terminal.label}`}
    >
      {/* Header: brain + label sur la même ligne (gain de place vertical
          pour l'iframe), session label en plus pour distinguer plusieurs
          sessions du même projet. Click-to-focus uniquement sur cette
          rangée — pas sur l'iframe en-dessous. */}
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
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}
        title="Click to focus this session"
      >
        <PixelBrain seed={seed} size={BRAIN_SIZE} active={active} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: '14px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {projectName}
          </span>
          <span
            style={{
              fontSize: '11px',
              opacity: 0.55,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {terminal.label}
          </span>
        </div>
        <StatusDot status={status} title={status} />
      </div>

      <SessionDashboard
        projectId={terminal.projectId}
        sessionId={terminal.sessionId}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Per-session HTML dashboard iframe
// ─────────────────────────────────────────────────────────────────────────

interface DashboardProps {
  projectId: string;
  sessionId: string | null;
}

/**
 * Renders an iframe (via `srcdoc` so it inherits no document context) that
 * reflects the contents of `~/.deepthix/projects/<pid>/dashboards/<sid>.html`.
 * Polls the file's mtime every 2s and re-reads the body only when it
 * changes — so claude can `Write` into the file and have its dashboard
 * appear here within ~2s.
 *
 * When the file doesn't exist yet, the iframe area stays blank. Claude
 * already knows where to write (DEEPTHIX_DASHBOARD_PATH env + the block
 * we inject into the project's CLAUDE.md), so the previous "tell this
 * session to write to <path>" placeholder was redundant noise.
 */
function SessionDashboard({ projectId, sessionId }: DashboardProps): React.JSX.Element | null {
  const [html, setHtml] = useState<string | null>(null);
  const lastMtimeRef = useRef<number>(-1);

  // Poll mtime and re-read the body only on change. Avoids re-rendering the
  // iframe on every tick (which would reset scroll/JS state inside it).
  useEffect(() => {
    if (!sessionId) {
      setHtml(null);
      lastMtimeRef.current = -1;
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const mtime = await dashboardMtimeMs(projectId, sessionId);
        if (cancelled) return;
        if (mtime !== lastMtimeRef.current) {
          lastMtimeRef.current = mtime;
          if (mtime === 0) {
            // File was deleted (or never existed). Clear the iframe.
            setHtml(null);
          } else {
            const body = await readSessionDashboard(projectId, sessionId);
            if (cancelled) return;
            setHtml(body);
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.warn('[Deepthix][SessionDashboard] poll failed', e);
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void tick(), DASHBOARD_POLL_MS);
        }
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, sessionId]);

  // Shell terminals get no dashboard slot at all (no session id → no file).
  if (!sessionId) return null;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        border: '2px solid var(--color-border)',
        background: 'var(--color-bg-dark)',
        // Tall iframe — the dashboard is THE main content of OVERVIEW
        // now that we only show the active project. Picks min(60vh, 600px)
        // so the iframe fills the page on a tall window without ever
        // pushing the header off screen on a short one.
        height: 'min(60vh, 600px)',
        minHeight: '420px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {html && html.length > 0 && (
        <iframe
          // Render the file contents inline via srcdoc — gives the iframe a
          // null origin (sandboxed by default) and avoids needing a custom
          // asset:// protocol for a file that lives outside the app bundle.
          srcDoc={html}
          // allow-scripts so claude can render charts / live counters; no
          // allow-same-origin so the iframe can't read parent state. No
          // allow-forms / allow-popups for the same reason.
          sandbox="allow-scripts"
          title={`session ${sessionId} dashboard`}
          style={{
            border: 'none',
            width: '100%',
            height: '100%',
            background: 'white',
          }}
        />
      )}
    </div>
  );
}
