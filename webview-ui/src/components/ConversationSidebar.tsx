// Conversation sidebar — messaging-app style left column.
//
//   [≡] [ Rechercher… ] [+]
//   Projets                      + Ajouter
//   [AB] Project name        Ctrl+1  15:23
//        Last message preview…
//
// Projects only: sessions stay in the tab strip of the main pane (user
// preference — no duplicate session list here). Each row shows the
// project's latest activity and last message, read from the tail of its
// sessions' JSONL via `session_previews` (polled every
// SIDEBAR_PREVIEW_POLL_MS). Ctrl+1…9 jumps to the Nth listed project.

import { Menu, Plus, Search, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CONTENT_SEARCH_DEBOUNCE_MS,
  CONTENT_SEARCH_MIN_CHARS,
  SIDEBAR_PREVIEW_POLL_MS,
} from '../constants';
import { avatarColor, formatWhen, initials, matches, splitOnMatch } from '../conversationUtils';
import { useAgentStatus } from '../hooks/useAgentStatus';
import type { TerminalEntry } from '../hooks/useTerminals';
import {
  type ConversationHit,
  searchConversations,
  type SessionPreview,
  sessionPreviews,
} from '../tauri/commands';
import type { Project } from '../tauri/types';

interface Props {
  projects: Project[];
  activeProjectId: string | null;
  terminals: TerminalEntry[];
  onSwitchProject: (id: string) => void;
  onOpenSession: (projectId: string, termId: string) => void;
  /** Open a transcript that has no session entry yet (content-search hit). */
  onResumeSession: (projectId: string, sessionId: string) => void;
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
  terminals,
  onSwitchProject,
  onOpenSession,
  onResumeSession,
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [previews, setPreviews] = useState<Map<string, SessionPreview>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);
  // Content search (Rust, every transcript of every project).
  const [hits, setHits] = useState<ConversationHit[]>([]);
  const [searching, setSearching] = useState(false);
  const projectsRef = useRef(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < CONTENT_SEARCH_MIN_CHARS) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      const list = projectsRef.current.map((p) => ({ project_id: p.id, cwd: p.path }));
      searchConversations(list, q)
        .then((out) => {
          if (!cancelled) setHits(out);
        })
        .catch((e) => console.error('[Elyone][ConversationSidebar] search failed', e))
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

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

  // Projects in display order → Ctrl+1…9 targets.
  const visibleRef = useRef(groups);
  useEffect(() => {
    visibleRef.current = groups;
  }, [groups]);
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
      const group = visibleRef.current[Number(ev.key) - 1];
      if (!group) return;
      ev.preventDefault();
      onSwitchProject(group.project.id);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onSwitchProject]);

  /** True when at least one session of the project is mid-turn. */
  const isWorking = useCallback(
    (g: ProjectGroup): boolean => g.sessions.some((s) => agentStatus.status(s.term.agentId) === 'working'),
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
        {groups.map((g, index) => {
          const p = g.project;
          const isActiveProject = p.id === activeProjectId;
          const newest = g.sessions[0];
          const working = isWorking(g);
          const shortcut = index < 9 ? index + 1 : null;
          return (
            <div key={p.id} className="dt-conv-group">
              <div
                role="button"
                tabIndex={0}
                className={`dt-conv-row dt-conv-project${isActiveProject ? ' is-active' : ''}`}
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
                    {shortcut && <kbd className="dt-conv-kbd">Ctrl+{shortcut}</kbd>}
                    <span className="dt-conv-time">{formatWhen(g.lastMs)}</span>
                  </span>
                  <span className="dt-conv-sub">
                    {working && <span className="dt-conv-status is-working">En cours… </span>}
                    {newest?.preview?.last_text ||
                      (g.sessions.length === 0 ? 'Aucune session' : newest?.term.label)}
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
            </div>
          );
        })}

        {query.trim().length >= CONTENT_SEARCH_MIN_CHARS && (
          <div className="dt-conv-hits">
            <div className="dt-conv-section dt-conv-section--inline">
              <span>Dans les conversations</span>
              <span>{searching ? 'Recherche…' : `${hits.length}${hits.length >= 50 ? '+' : ''}`}</span>
            </div>
            {!searching && hits.length === 0 && (
              <div className="dt-conv-empty">Aucun passage ne contient « {query.trim()} ».</div>
            )}
            {hits.map((h, i) => {
              const project = projects.find((p) => p.id === h.project_id);
              const term = claudeSessions.find(
                (t) => t.sessionId === h.session_id && t.projectId === h.project_id,
              );
              const parts = splitOnMatch(h.snippet, query);
              const open = (): void => {
                if (term) onOpenSession(h.project_id, term.id);
                else onResumeSession(h.project_id, h.session_id);
              };
              return (
                <div
                  key={`${h.session_id}-${i}`}
                  role="button"
                  tabIndex={0}
                  className="dt-conv-row dt-conv-hit"
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') open();
                  }}
                  title={term ? 'Ouvrir la session' : 'Rouvrir cette conversation dans une nouvelle session'}
                >
                  <span
                    className="dt-conv-avatar dt-conv-avatar--sm"
                    style={{ background: avatarColor(h.project_id) }}
                    aria-hidden
                  >
                    {initials(project?.name ?? '?')}
                  </span>
                  <span className="dt-conv-text">
                    <span className="dt-conv-line">
                      <span className="dt-conv-title dt-conv-title--sm">
                        {project?.name ?? 'Projet'} · {term?.label ?? 'Ancienne conversation'}
                      </span>
                      <span className="dt-conv-time">{formatWhen(h.mtime_ms)}</span>
                    </span>
                    <span className="dt-conv-snippet">
                      {h.role === 'user' ? 'Toi : ' : ''}
                      {parts ? (
                        <>
                          {parts[0]}
                          <mark>{parts[1]}</mark>
                          {parts[2]}
                        </>
                      ) : (
                        h.snippet
                      )}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
