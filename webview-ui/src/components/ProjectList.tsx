import { useEffect, useMemo, useRef, useState } from 'react';

import { useAgentStatus } from '../hooks/useAgentStatus';
import type { TerminalEntry } from '../hooks/useTerminals';
import { jsonlMtimeMs } from '../tauri/commands';
import type { Project } from '../tauri/types';
import { StatusDot } from './StatusDot';

/** How often to re-scan the JSONL mtimes to keep the sidebar sorted by
 *  last-chat-message. 30s is enough for the user to notice the order
 *  refreshing without hammering the disk (every Tauri call = one stat()).
 */
const ACTIVITY_POLL_MS = 30_000;

interface Props {
  projects: Project[];
  activeProjectId: string | null;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onOpenFolder: () => void;
  /**
   * All terminals across every project (Phase 11). Used to compute the
   * per-project aggregate status dot — `working` if any of its claude
   * sessions is using a tool, `idle` if any session exists, `absent`
   * (no dot) if the project has no sessions yet.
   */
  terminals: TerminalEntry[];
  /** Click handler for the SETTINGS button at the top of the sidebar. */
  onOpenSettings: () => void;
  /** True when the parent's `mode === 'settings'` so we can highlight the button. */
  settingsActive: boolean;
}

export function ProjectList({
  projects,
  activeProjectId,
  onSwitch,
  onRemove,
  onRename,
  onOpenFolder,
  terminals,
  onOpenSettings,
  settingsActive,
}: Props): React.JSX.Element {
  // Inline rename state — mirrors the SessionsPane sub-tab rename pattern in
  // BottomPanel.tsx: double-click to enter edit mode, Enter saves, Escape
  // cancels, blur saves.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const agentStatus = useAgentStatus();

  // Pre-bucket terminals by project so we don't re-scan the array N×M times.
  const sessionsByProject = useMemo(() => {
    const map = new Map<string, TerminalEntry[]>();
    for (const t of terminals) {
      if (t.kind !== 'claude') continue;
      const arr = map.get(t.projectId);
      if (arr) arr.push(t);
      else map.set(t.projectId, [t]);
    }
    return map;
  }, [terminals]);

  // Per-(project, sessionId) JSONL mtime cache. Polled every
  // ACTIVITY_POLL_MS so projects re-sort when claude writes a new
  // message into one of their sessions (the actual "last activity"
  // the user cares about — not just when they clicked-to-switch).
  const [sessionMtimes, setSessionMtimes] = useState<Map<string, number>>(new Map());
  // Re-derive a stable list of (cwd, sessionId) pairs to query so the
  // polling effect doesn't fire on every terminal-list re-render — only
  // when the actual set of sessions changes.
  const sessionsToProbe = useMemo(() => {
    const out: { cwd: string; sessionId: string; key: string }[] = [];
    for (const t of terminals) {
      if (t.kind !== 'claude' || !t.sessionId) continue;
      out.push({
        cwd: t.cwd,
        sessionId: t.sessionId,
        key: `${t.cwd}::${t.sessionId}`,
      });
    }
    return out;
  }, [terminals]);
  const sessionsKey = useMemo(
    () =>
      sessionsToProbe
        .map((s) => s.key)
        .sort()
        .join('|'),
    [sessionsToProbe],
  );
  const sessionsToProbeRef = useRef(sessionsToProbe);
  useEffect(() => {
    sessionsToProbeRef.current = sessionsToProbe;
  }, [sessionsToProbe]);
  useEffect(() => {
    let cancelled = false;
    const probe = async (): Promise<void> => {
      const targets = sessionsToProbeRef.current;
      if (targets.length === 0) return;
      const results = await Promise.allSettled(
        targets.map((s) => jsonlMtimeMs(s.cwd, s.sessionId)),
      );
      if (cancelled) return;
      setSessionMtimes((prev) => {
        const next = new Map(prev);
        results.forEach((r, i) => {
          if (r.status === 'fulfilled' && r.value.mtime_ms > 0) {
            next.set(targets[i].key, r.value.mtime_ms);
          }
        });
        return next;
      });
    };
    // Fire once immediately so the first sort reflects disk state, then
    // poll on a slow interval. Re-runs when the set of sessions changes
    // (sessionsKey memo above) so newly-added sessions get probed too.
    void probe();
    const interval = setInterval(() => void probe(), ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionsKey]);

  // Sort projects by their last *chat* activity (max JSONL mtime across
  // their sessions) — so the project where claude just wrote a reply
  // bubbles to the top even if the user is currently on another
  // project. Fallback to last_opened_unix_ms when a project has no
  // sessions yet.
  const sortedProjects = useMemo(() => {
    const activityForProject = (projectId: string, cwd: string): number => {
      const sessions = sessionsByProject.get(projectId) ?? [];
      let max = 0;
      for (const s of sessions) {
        if (!s.sessionId) continue;
        const t = sessionMtimes.get(`${cwd}::${s.sessionId}`) ?? 0;
        if (t > max) max = t;
      }
      return max;
    };
    return [...projects].sort((a, b) => {
      const ta = activityForProject(a.id, a.path) || (a.last_opened_unix_ms ?? 0);
      const tb = activityForProject(b.id, b.path) || (b.last_opened_unix_ms ?? 0);
      return tb - ta;
    });
  }, [projects, sessionsByProject, sessionMtimes]);

  const commitRename = (id: string, original: string): void => {
    const trimmed = editingValue.trim();
    if (trimmed && trimmed !== original) {
      console.debug('[Deepthix][ProjectList] commit rename', { id, name: trimmed });
      onRename(id, trimmed);
    } else {
      console.debug('[Deepthix][ProjectList] rename no-op', { id });
    }
    setEditingId(null);
  };

  return (
    <div
      className="project-list"
      style={{
        background: 'var(--color-bg)',
        borderRight: '2px solid var(--color-border)',
        padding: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      {/* SETTINGS button (Phase 11). Sits above the PROJECTS section so
          it's always reachable; switches the right pane to the SettingsPane. */}
      <button
        type="button"
        onClick={onOpenSettings}
        className={settingsActive ? 'dt-btn dt-btn--primary' : 'dt-btn'}
        style={{
          marginBottom: '6px',
          fontSize: '13px',
          letterSpacing: '0.06em',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
        title="Edit global terminal & app settings"
      >
        <span aria-hidden>⚙</span>
        <span>SETTINGS</span>
      </button>

      <div className="dt-section-header" style={{ paddingLeft: 4, paddingTop: 6 }}>
        <span>Projects</span>
        <span style={{ opacity: 0.65, fontSize: 9 }}>{projects.length}</span>
      </div>
      {projects.length === 0 && (
        <div style={{ fontSize: '13px', opacity: 0.6, padding: '4px' }}>
          No projects yet.
        </div>
      )}
      {sortedProjects.map((p) => {
        const isActive = p.id === activeProjectId;
        const isEditing = editingId === p.id;
        const sessions = sessionsByProject.get(p.id) ?? [];
        // Aggregate status: working if ANY session is working, idle if ANY
        // session exists at all, absent (no dot) if there are no sessions.
        const projectStatus =
          sessions.length === 0
            ? 'absent'
            : sessions.some((s) => agentStatus.status(s.agentId) === 'working')
              ? 'working'
              : 'idle';
        return (
          <div
            key={p.id}
            className={isActive ? '' : 'dt-row'}
            role="button"
            tabIndex={0}
            onClick={() => !isEditing && onSwitch(p.id)}
            onDoubleClick={() => {
              console.debug('[Deepthix][ProjectList] enter edit', { id: p.id });
              setEditingId(p.id);
              setEditingValue(p.name);
            }}
            onKeyDown={(e) => {
              if (isEditing) return;
              if (e.key === 'Enter' || e.key === ' ') onSwitch(p.id);
            }}
            style={{
              cursor: isEditing ? 'text' : 'pointer',
              padding: '5px 8px',
              background: isActive ? 'var(--color-accent)' : 'transparent',
              color: isActive ? 'var(--color-bg-dark)' : 'inherit',
              borderLeft: isActive
                ? '3px solid var(--color-bg-dark)'
                : '3px solid transparent',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '6px',
            }}
            title={isEditing ? 'Editing name' : `${p.path}\n(double-click to rename)`}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', flex: 1 }}>
              <span style={{ opacity: isActive ? 1 : 0 }}>●</span>
              {/* Aggregate status dot per project (Phase 11). Empty span when
                  status is 'absent' so spacing stays consistent. */}
              <StatusDot
                status={projectStatus}
                title={`${p.name} — ${projectStatus === 'absent' ? 'no sessions' : projectStatus}`}
              />
              {isEditing ? (
                <input
                  autoFocus
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => commitRename(p.id, p.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename(p.id, p.name);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingId(null);
                    }
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: '14px',
                    width: '100%',
                    outline: 'none',
                  }}
                />
              ) : (
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(p.id);
              }}
              aria-label={`Remove ${p.name}`}
              style={{
                background: 'transparent',
                color: 'inherit',
                border: 'none',
                cursor: 'pointer',
                opacity: 0.6,
                padding: '0 4px',
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onOpenFolder}
        style={{
          marginTop: '6px',
          padding: '6px 8px',
          background: 'transparent',
          color: 'inherit',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          cursor: 'pointer',
          fontSize: '13px',
          fontFamily: 'var(--font-pixel)',
        }}
      >
        + Open Folder
      </button>
    </div>
  );
}
