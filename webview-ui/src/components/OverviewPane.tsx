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
  ptyWrite,
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
        // No more outer overflow:auto — the iframe is the main content
        // and it scrolls internally. Letting the page scroll AND the
        // iframe scroll just makes both feel broken.
        overflow: 'hidden',
        fontFamily: 'var(--font-pixel)',
        display: 'flex',
        flexDirection: 'column',
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
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            flex: 1,
            minHeight: 0,
          }}
        >
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
  // Active session for the iframe. If the user clicks a tab, switch to
  // that one. Default to the first session and re-sync if it gets
  // removed (e.g. session closed externally).
  const [activeSessionId, setActiveSessionId] = useState<string>(group.sessions[0]?.id ?? '');
  useEffect(() => {
    if (!group.sessions.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(group.sessions[0]?.id ?? '');
    }
  }, [group.sessions, activeSessionId]);

  const activeSession = group.sessions.find((s) => s.id === activeSessionId) ?? group.sessions[0];
  const activeIdx = activeSession ? group.sessions.indexOf(activeSession) : 0;
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
        gap: '10px',
        // Fill the OVERVIEW pane vertically — the iframe inside is the
        // main content.
        flex: 1,
        minHeight: 0,
        fontFamily: 'var(--font-pixel)',
      }}
    >
      {/* Top bar: project info on the left, session pills on the right.
          Pills switch which session's iframe is shown below; jump-to-
          session-terminal still works via the FOCUS button so the user
          can flip to the SESSIONS pane without losing the dashboard
          view they're inspecting. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          borderBottom: '2px solid var(--color-border)',
          paddingBottom: '8px',
          flexWrap: 'wrap',
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
              minWidth: 0,
            }}
            title={group.projectPath}
          >
            {group.projectPath}
          </span>
        )}
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {group.sessions.map((s, idx) => (
            <SessionPill
              key={s.id}
              terminal={s}
              seed={`${s.projectId}#${idx}`}
              status={status(s.agentId)}
              isActive={s.id === activeSession?.id}
              onClick={() => setActiveSessionId(s.id)}
              onFocus={() => onPickSession(s)}
            />
          ))}
        </div>
      </div>

      {/* Pleine hauteur — l'iframe occupe tout le reste de la pane. */}
      {activeSession && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <SessionDashboard
            key={activeSession.id}
            termId={activeSession.id}
            projectId={activeSession.projectId}
            sessionId={activeSession.sessionId}
            seed={`${activeSession.projectId}#${activeIdx}`}
            sessionLabel={activeSession.label}
            isWorking={status(activeSession.agentId) === 'working'}
          />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Single session card
// ─────────────────────────────────────────────────────────────────────────

/** How often we poll the dashboard file's mtime. Cheap call (just stat). */
const DASHBOARD_POLL_MS = 2_000;
const PILL_BRAIN_SIZE = 28;

interface PillProps {
  terminal: TerminalEntry;
  seed: string;
  status: 'idle' | 'working' | 'absent';
  isActive: boolean;
  /** Make this session's dashboard the visible one (no terminal jump). */
  onClick: () => void;
  /** Jump to the SESSIONS pane and focus this session's terminal. */
  onFocus: () => void;
}

function SessionPill({
  terminal,
  seed,
  status,
  isActive,
  onClick,
  onFocus,
}: PillProps): React.JSX.Element {
  const working = status === 'working';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px 4px 4px',
        background: isActive ? 'var(--color-accent)' : 'var(--color-bg-dark)',
        color: isActive ? 'var(--color-bg-dark)' : 'inherit',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        cursor: 'pointer',
        fontFamily: 'var(--font-pixel)',
        fontSize: '12px',
      }}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      title={`${terminal.label} — click to view dashboard`}
    >
      <PixelBrain seed={seed} size={PILL_BRAIN_SIZE} active={working} />
      <span style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {terminal.label}
      </span>
      <StatusDot status={status} size={8} title={status} />
      <span
        role="button"
        tabIndex={0}
        title="Open this session's terminal"
        onClick={(e) => {
          e.stopPropagation();
          onFocus();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            onFocus();
          }
        }}
        style={{
          marginLeft: '4px',
          padding: '0 4px',
          fontSize: '10px',
          opacity: 0.7,
          borderLeft: '1px solid currentColor',
        }}
      >
        ↗
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Per-session HTML dashboard iframe
// ─────────────────────────────────────────────────────────────────────────

interface DashboardProps {
  /** Terminal id (term-xxxxx) — what we ptyWrite button actions into. */
  termId: string;
  projectId: string;
  sessionId: string | null;
  /** Brain seed for the empty-state preview. Stable per session. */
  seed: string;
  /** Session label shown next to the brain in the empty state. */
  sessionLabel: string;
  /** Drives the brain animation while there's no dashboard yet. */
  isWorking: boolean;
}

const EMPTY_BRAIN_SIZE = 96;

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
function SessionDashboard({
  termId,
  projectId,
  sessionId,
  seed,
  sessionLabel,
  isWorking,
}: DashboardProps): React.JSX.Element | null {
  const [html, setHtml] = useState<string | null>(null);
  const lastMtimeRef = useRef<number>(-1);

  // Listen for postMessage events from the dashboard iframe. Buttons
  // marked with `data-deepthix-action="..."` send their action label
  // back here via the shim we inject into the dashboard HTML below.
  // We forward the action as a typed string to the claude session's
  // pty stdin — claude reads it the same as a user prompt.
  useEffect(() => {
    function onMessage(ev: MessageEvent): void {
      // Sandboxed iframes have origin "null"; the message data shape
      // is the only thing we trust.
      const data = ev.data as unknown;
      if (!data || typeof data !== 'object') return;
      const msg = data as Record<string, unknown>;
      if (msg.type !== 'deepthix-dashboard-action') return;
      if (msg.termId !== termId) return; // not for this session's iframe
      const action = typeof msg.action === 'string' ? msg.action.trim() : '';
      const payload = typeof msg.payload === 'string' ? msg.payload : '';
      if (!action) return;
      // Compose the prompt we send to claude. payload is optional —
      // most buttons just signal an intent ("refresh meta ads") with
      // no extra arguments.
      const prompt = payload ? `${action} ${payload}` : action;
      console.info('[Deepthix][SessionDashboard] dashboard button →', {
        termId,
        prompt,
      });
      // Trailing \r so claude treats it as a submitted prompt.
      void ptyWrite(termId, `${prompt}\r`).catch((err) => {
        console.warn('[Deepthix][SessionDashboard] ptyWrite failed', err);
      });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [termId]);

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
        // Fill ALL available space — the parent ProjectGroupView is a
        // flex column with `flex: 1, minHeight: 0`, so we pick up
        // whatever's left after the project header.
        flex: 1,
        minHeight: '300px',
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
          // We append a small shim script so any element with
          // data-deepthix-action automatically posts the action label back
          // to the parent — claude only has to write semantic markup, no
          // postMessage boilerplate per dashboard.
          srcDoc={withDashboardShim(html, termId)}
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
        // Pretty empty state — big brain in the middle of the empty
        // canvas + a single line telling the user nothing has been
        // written yet. The brain pulses if claude is actually working
        // so it doesn't feel dead during a long thinking phase.
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            opacity: 0.85,
          }}
        >
          <PixelBrain seed={seed} size={EMPTY_BRAIN_SIZE} active={isWorking} />
          <span
            style={{
              fontSize: '13px',
              fontFamily: 'var(--font-pixel)',
              color: 'var(--color-text)',
            }}
          >
            {sessionLabel}
          </span>
          <span
            style={{
              fontSize: '11px',
              opacity: 0.5,
              fontFamily: 'var(--font-pixel)',
            }}
          >
            {isWorking ? 'thinking…' : 'no dashboard yet'}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Wrap the dashboard HTML with a tiny shim that turns any element with
 * `data-deepthix-action="..."` into a button that posts its action back
 * to the parent window. Claude only writes semantic markup:
 *
 *   <button data-deepthix-action="refresh meta ads">Refresh</button>
 *   <button data-deepthix-action="run health check">Run check</button>
 *
 * On click, the shim posts:
 *   { type: 'deepthix-dashboard-action', termId, action, payload }
 *
 * Optional `data-deepthix-payload` is forwarded as a free-form arg.
 *
 * The shim runs once at iframe load. Dashboards are re-rendered every
 * time the source file changes (claude rewrites the HTML), so we don't
 * need a MutationObserver — the shim re-attaches on every reload.
 */
function withDashboardShim(html: string, termId: string): string {
  // termId is interpolated into a JS string — strip quote/backslash
  // chars defensively even though Tauri-generated ids are alphanumeric+dashes.
  const safeTermId = termId.replace(/['"\\]/g, '');
  const shim = `
<script>
(function () {
  var TERM = '${safeTermId}';
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest && ev.target.closest('[data-deepthix-action]');
    if (!el) return;
    ev.preventDefault();
    var action = el.getAttribute('data-deepthix-action') || '';
    var payload = el.getAttribute('data-deepthix-payload') || '';
    parent.postMessage({
      type: 'deepthix-dashboard-action',
      termId: TERM,
      action: action,
      payload: payload,
    }, '*');
  }, false);
})();
</script>`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${shim}</body>`);
  }
  return html + shim;
}
