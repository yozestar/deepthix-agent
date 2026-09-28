// Conversation sidebar — messaging-app style left column.
//
//   [≡] [ Rechercher une conversation ] [+]
//   Projets                      + Ajouter
//   [AB] Project name                 15:23
//        Last message preview…
//      (ab) Session label   Ctrl+1    15:23
//           En pause — preview…
//
// Every project is listed with its sessions nested underneath (most recent
// first, 3 visible + expander). Previews come from the tail of each
// session's JSONL via `session_previews`, polled every
// SIDEBAR_PREVIEW_POLL_MS. Ctrl+1…9 jumps to the Nth visible session.

import { Menu, Plus, Search, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SIDEBAR_PREVIEW_POLL_MS, SIDEBAR_SESSIONS_PER_PROJECT } from '../constants';
import { avatarColor, formatWhen, initials, matches } from '../conversationUtils';
import { useAgentStatus } from '../hooks/useAgentStatus';
import type { TerminalEntry } from '../hooks/useTerminals';
import { type SessionPreview, sessionPreviews } from '../tauri/commands';
import type { Project } from '../tauri/types';

interface Props {
  projects: Project[];
  activeProjectId: string | null;
  /** Session currently shown in the chat area (terminal entry id). */
  activeTermId: string | null;
  terminals: TerminalEntry[];
  onSwitchProject: (id: string) => void;
  onOpenSession: (projectId: string, termId: string) => void;
  onRemoveProject: (id: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onAddProject: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  settingsActive: boolean;
}

// ── Component ──────────────────────────────────────────────────────────

interface SessionRow {
  term: TerminalEntry;
  preview: SessionPreview | undefined;
  lastMs: number;
}

interface ProjectGroup {
  project: Project;
  sessions: SessionRow[];
  lastMs: number;
  /** Search hit on the project itself (name/path) → show all its sessions. */
  projectHit: boolean;
}

export function ConversationSidebar({
  projects,
  activeProjectId,
  activeTermId,
  terminals,
  onSwitchProject,
  onOpenSession,
  onRemoveProject,
  onRenameProject,
  onAddProject,
  onNewSession,
  onOpenSettings,
  settingsActive,
}: Props): React.JSX.Element {
  const agentStatus = useAgentStatus();
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [previews, setPreviews] = useState<Map<string, SessionPreview>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);

  const claudeSessions = useMemo(
    () => terminals.filter((t) => t.kind === 'claude' && t.sessionId),
    [terminals],
  );

  // Poll previews for every known session. Keyed by the sorted id list so
  // the effect only restarts when the set of sessions actually changes.
  const probeKey = useMemo(
    () =>
      claudeSessions
        .map((t) => t.sessionId)
        .sort()
        .join('|'),
    [claudeSessions],
  );
  const sessionsRef = useRef(claudeSessions);
  useEffect(() => {
    sessionsRef.current = claudeSessions;
  }, [claudeSessions]);
  useEffect(() => {
    let cancelled = false;
    const probe = async (): Promise<void> => {
      const items = sessionsRef.current.map((t) => ({ cwd: t.cwd, session_id: t.sessionId as string }));
      if (items.length === 0) return;
      try {
        const out = await sessionPreviews(items);
        if (cancelled) return;
        setPreviews(new Map(out.map((p) => [p.session_id, p])));
      } catch (e) {
        console.error('[Elyone][ConversationSidebar] previews failed', e);
      }
    };
    void probe();
    const iv = setInterval(() => void probe(), SIDEBAR_PREVIEW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [probeKey]);

  // Group sessions under projects, newest activity first, then filter.
  const groups = useMemo<ProjectGroup[]>(() => {
    const q = query.trim();
    const byProject = new Map<string, SessionRow[]>();
    for (const t of claudeSessions) {
      const preview = previews.get(t.sessionId as string);
      const row: SessionRow = { term: t, preview, lastMs: preview?.mtime_ms ?? 0 };
      const arr = byProject.get(t.projectId);
      if (arr) arr.push(row);
      else byProject.set(t.projectId, [row]);
    }
    const out: ProjectGroup[] = [];
    for (const project of projects) {
      const all = (byProject.get(project.id) ?? []).sort((a, b) => b.lastMs - a.lastMs);
      const lastMs = Math.max(all[0]?.lastMs ?? 0, 0) || project.last_opened_unix_ms || 0;
      if (!q) {
        out.push({ project, sessions: all, lastMs, projectHit: false });
        continue;
      }
      const projectHit = matches(project.name, q) || matches(project.path, q);
      const hitSessions = all.filter(
        (s) => matches(s.term.label, q) || matches(s.preview?.last_text ?? '', q),
      );
      if (projectHit || hitSessions.length > 0) {
        out.push({ project, sessions: projectHit ? all : hitSessions, lastMs, projectHit });
      }
    }
    return out.sort((a, b) => b.lastMs - a.lastMs);
  }, [projects, claudeSessions, previews, query]);

  // Sessions actually rendered, in display order → Ctrl+1…9 targets.
  const visibleSessions = useMemo(() => {
    const list: SessionRow[] = [];
    for (const g of groups) {
      const limit =
        query.trim() || expanded.has(g.project.id) ? g.sessions.length : SIDEBAR_SESSIONS_PER_PROJECT;
      list.push(...g.sessions.slice(0, limit));
    }
    return list;
  }, [groups, expanded, query]);
  const shortcutIndex = useMemo(() => {
    const m = new Map<string, number>();
    visibleSessions.slice(0, 9).forEach((s, i) => m.set(s.term.id, i + 1));
    return m;
  }, [visibleSessions]);

  const visibleRef = useRef(visibleSessions);
  useEffect(() => {
    visibleRef.current = visibleSessions;
  }, [visibleSessions]);
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent): void {
      if (!ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
      const target = ev.target as Element | null;
      if (target?.closest?.('.xterm')) return;
      if (ev.key === 'k' || ev.key === 'K') {
        ev.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (!/^[1-9]$/.test(ev.key)) return;
      const row = visibleRef.current[Number(ev.key) - 1];
      if (!row) return;
      ev.preventDefault();
      onOpenSession(row.term.projectId, row.term.id);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpenSession]);

  const statusLabel = useCallback(
    (t: TerminalEntry): { text: string; working: boolean } => {
      if (agentStatus.status(t.agentId) === 'working') return { text: 'En cours…', working: true };
      if (t.id.startsWith('ghost:')) return { text: 'En pause', working: false };
      return { text: 'Prêt', working: false };
    },
    [agentStatus],
  );

  const commitRename = (id: string, original: string): void => {
    const trimmed = editingValue.trim();
    if (trimmed && trimmed !== original) onRenameProject(id, trimmed);
    setEditingId(null);
  };

  return (
    <div className="dt-conv">
      {/* Brand row. The colour mark sits on a white tile: the charter
          forbids recolouring it, and the blue loop would vanish on the
          blue sidebar. */}
      <div className="dt-conv-brand">
        <span className="dt-conv-brand-tile">
          <img src="/brand/elyone-mark.png" alt="Elyone" />
        </span>
        <span className="dt-conv-brand-name">
          <strong>Elyone</strong> AI Desktop Agent
        </span>
      </div>

      {/* Top bar: menu · search · new session */}
      <div className="dt-conv-top">
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className={`dt-conv-iconbtn${settingsActive ? ' is-active' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            title="Menu"
            aria-label="Menu"
          >
            <Menu size="1.15em" strokeWidth={1.75} aria-hidden />
          </button>
          {menuOpen && (
            <div className="dt-conv-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings();
                }}
              >
                <Settings size="1em" strokeWidth={1.75} aria-hidden /> Réglages
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onAddProject();
                }}
              >
                <Plus size="1em" strokeWidth={1.75} aria-hidden /> Ajouter un projet
              </button>
            </div>
          )}
        </div>
        <label className="dt-conv-search">
          <Search size="1em" strokeWidth={1.75} aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Rechercher…"
            aria-label="Rechercher une conversation"
            title="Rechercher (Ctrl+K)"
          />
          {query && (
            <button type="button" className="dt-conv-clear" onClick={() => setQuery('')} aria-label="Effacer">
              <X size="0.9em" strokeWidth={2} aria-hidden />
            </button>
          )}
        </label>
        <button
          type="button"
          className="dt-conv-iconbtn"
          onClick={onNewSession}
          disabled={!activeProjectId}
          title="Nouvelle session dans le projet actif"
          aria-label="Nouvelle session"
        >
          <Plus size="1.15em" strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <div className="dt-conv-section">
        <span>Projets</span>
        <button type="button" className="dt-conv-link" onClick={onAddProject}>
          <Plus size="0.95em" strokeWidth={2} aria-hidden /> Ajouter
        </button>
      </div>

      <div className="dt-conv-list">
        {projects.length === 0 && <div className="dt-conv-empty">Aucun projet pour l&apos;instant.</div>}
        {projects.length > 0 && groups.length === 0 && (
          <div className="dt-conv-empty">Aucun résultat pour « {query} ».</div>
        )}
        {groups.map((g) => {
          const p = g.project;
          const isActiveProject = p.id === activeProjectId;
          const newest = g.sessions[0];
          const isExpanded = expanded.has(p.id) || !!query.trim();
          const shown = isExpanded ? g.sessions : g.sessions.slice(0, SIDEBAR_SESSIONS_PER_PROJECT);
          const hidden = g.sessions.length - shown.length;
          return (
            <div key={p.id} className="dt-conv-group">
              <div
                role="button"
                tabIndex={0}
                className={`dt-conv-row dt-conv-project${isActiveProject ? ' is-current' : ''}`}
                onClick={() => editingId !== p.id && onSwitchProject(p.id)}
                onDoubleClick={() => {
                  setEditingId(p.id);
                  setEditingValue(p.name);
                }}
                onKeyDown={(e) => {
                  if (editingId === p.id) return;
                  if (e.key === 'Enter' || e.key === ' ') onSwitchProject(p.id);
                }}
                title={`${p.path}\n(double-clic pour renommer)`}
              >
                <span className="dt-conv-avatar" style={{ background: avatarColor(p.id) }} aria-hidden>
                  {initials(p.name)}
                </span>
                <span className="dt-conv-text">
                  <span className="dt-conv-line">
                    {editingId === p.id ? (
                      <input
                        autoFocus
                        className="dt-conv-rename"
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
                      />
                    ) : (
                      <span className="dt-conv-title">{p.name}</span>
                    )}
                    <span className="dt-conv-time">{formatWhen(g.lastMs)}</span>
                  </span>
                  <span className="dt-conv-sub">
                    {newest?.preview?.last_text || (g.sessions.length === 0 ? 'Aucune session' : newest?.term.label)}
                  </span>
                </span>
                <button
                  type="button"
                  className="dt-conv-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveProject(p.id);
                  }}
                  aria-label={`Retirer ${p.name}`}
                  title="Retirer ce projet de la liste"
                >
                  <X size="0.9em" strokeWidth={2} aria-hidden />
                </button>
              </div>

              {shown.map((s) => {
                const isActive = s.term.id === activeTermId && isActiveProject;
                const st = statusLabel(s.term);
                const shortcut = shortcutIndex.get(s.term.id);
                return (
                  <div
                    key={s.term.id}
                    role="button"
                    tabIndex={0}
                    className={`dt-conv-row dt-conv-session${isActive ? ' is-active' : ''}`}
                    onClick={() => onOpenSession(p.id, s.term.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') onOpenSession(p.id, s.term.id);
                    }}
                    title={s.term.label}
                  >
                    <span
                      className="dt-conv-avatar dt-conv-avatar--sm"
                      style={{ background: avatarColor(p.id) }}
                      aria-hidden
                    >
                      {initials(s.term.label || p.name)}
                    </span>
                    <span className="dt-conv-text">
                      <span className="dt-conv-line">
                        <span className="dt-conv-title dt-conv-title--sm">{s.term.label}</span>
                        {shortcut && <kbd className="dt-conv-kbd">Ctrl+{shortcut}</kbd>}
                        <span className="dt-conv-time">{formatWhen(s.lastMs)}</span>
                      </span>
                      <span className="dt-conv-sub">
                        <span className={st.working ? 'dt-conv-status is-working' : 'dt-conv-status'}>
                          {st.text}
                        </span>
                        {s.preview?.last_text ? ` — ${s.preview.last_text}` : ''}
                      </span>
                    </span>
                  </div>
                );
              })}
              {hidden > 0 && (
                <button
                  type="button"
                  className="dt-conv-more"
                  onClick={() => setExpanded((prev) => new Set(prev).add(p.id))}
                >
                  {hidden} autre{hidden > 1 ? 's' : ''} session{hidden > 1 ? 's' : ''}…
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
