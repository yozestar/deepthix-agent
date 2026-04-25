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
import {
  dashboardMtimeMs,
  dashboardPath,
  readSessionDashboard,
} from '../tauri/commands';
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

      {/* Brain cards + per-session live HTML dashboard. The grid is wider
          than before (min 320px) so the iframe has room to breathe. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
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
        padding: '10px',
        background: active ? 'var(--color-bg-dark)' : 'transparent',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        fontFamily: 'var(--font-pixel)',
        position: 'relative',
      }}
      title={`${projectName} — ${terminal.label}`}
    >
      {/* Status dot pinned top-right so it doesn't compete with the brain. */}
      <div style={{ position: 'absolute', top: 6, right: 6 }}>
        <StatusDot status={status} title={status} />
      </div>

      {/* Brain + label. Click-to-focus is on this header only — clicks in
          the iframe area below should NOT also switch sessions. */}
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
          flexDirection: 'column',
          alignItems: 'center',
          gap: '6px',
        }}
        title="Click to focus this session"
      >
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
 * changes, so claude can `Write` into the file and have its dashboard
 * appear here within ~2s.
 *
 * When the file doesn't exist yet, we show a placeholder explaining the
 * path so the user can paste it into a claude prompt — e.g. "write your
 * progress to /Users/.../sid.html and update it as you work".
 */
function SessionDashboard({ projectId, sessionId }: DashboardProps): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null);
  const [path, setPath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const lastMtimeRef = useRef<number>(-1);

  // Resolve the absolute path once for the placeholder + copy-button.
  useEffect(() => {
    if (!sessionId) {
      setPath('');
      return;
    }
    let cancelled = false;
    void dashboardPath(projectId, sessionId)
      .then((p) => {
        if (!cancelled) setPath(p);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn('[Deepthix][SessionDashboard] dashboardPath failed', e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId]);

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
            setError(null);
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.warn('[Deepthix][SessionDashboard] poll failed', e);
          setError(e instanceof Error ? e.message : String(e));
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

  if (!sessionId) {
    return (
      <div
        style={{
          padding: '10px',
          fontSize: '11px',
          opacity: 0.55,
          border: '1px dashed var(--color-border)',
          background: 'var(--color-bg-dark)',
        }}
      >
        Shell terminals don't have a dashboard.
      </div>
    );
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        border: '2px solid var(--color-border)',
        background: 'var(--color-bg-dark)',
        // Fixed height keeps the OVERVIEW grid consistent — the iframe
        // scrolls internally if claude writes a long page.
        height: '260px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {html && html.length > 0 ? (
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
      ) : (
        <DashboardPlaceholder path={path} error={error} />
      )}
    </div>
  );
}

interface PlaceholderProps {
  path: string;
  error: string | null;
}

function DashboardPlaceholder({ path, error }: PlaceholderProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn('[Deepthix][DashboardPlaceholder] copy failed', e);
    }
  };
  return (
    <div
      style={{
        padding: '10px',
        fontSize: '11px',
        color: 'var(--color-text-muted)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'auto',
      }}
    >
      <div style={{ fontSize: '12px', color: 'var(--color-text)' }}>
        Dashboard space — empty.
      </div>
      <div>
        Tell this session to write its important data as HTML to:
      </div>
      <code
        style={{
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          padding: '4px 6px',
          fontSize: '10px',
          wordBreak: 'break-all',
          fontFamily: 'var(--font-pixel)',
        }}
        title={path}
      >
        {path || '(resolving…)'}
      </code>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void onCopy();
        }}
        disabled={!path}
        style={{
          alignSelf: 'flex-start',
          padding: '3px 8px',
          fontSize: '11px',
          background: 'transparent',
          color: 'inherit',
          border: '2px solid var(--color-border)',
          fontFamily: 'var(--font-pixel)',
          cursor: path ? 'pointer' : 'default',
        }}
      >
        {copied ? '✓ copied' : 'copy path'}
      </button>
      {error && (
        <div style={{ color: 'var(--color-danger)', fontSize: '10px' }}>{error}</div>
      )}
    </div>
  );
}
