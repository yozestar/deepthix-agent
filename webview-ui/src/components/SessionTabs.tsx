// Session tab strip — card-style tabs in the spirit of the project sidebar:
// round avatar, bold name, status + last-message time underneath, close
// button on hover. Ends with "+" (new session, with a menu for the
// "skip permissions" variant) and "Historique" (closed sessions + other
// conversations of the project, reopenable with their full history).
//
// Shortcuts (browser-like): Ctrl+W closes the active tab, Ctrl+Shift+T
// reopens the last closed one.
//
// Order is automatic: most recent message first (left), oldest last; a
// conversation that just got a message jumps to the front. Shell tabs go
// last. Right-click a conversation tab → "Déplacer vers…" another project.

import { ChevronDown, FolderInput, History, Plus, SquareTerminal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { TAB_ORDER_POLL_MS } from '../constants';
import { avatarColor, formatWhen, initials, matches } from '../conversationUtils';
import { useAgentStatus } from '../hooks/useAgentStatus';
import { useFormFactor } from '../hooks/useFormFactor';
import type { TerminalEntry, UseTerminalsResult } from '../hooks/useTerminals';
import {
  listResumableSessions,
  type ResumableSession,
  type SessionPreview,
  sessionPreviews,
} from '../tauri/commands';
import type { Project } from '../tauri/types';

interface Props {
  terminals: UseTerminalsResult;
  projectId: string | null;
  /** Project folder — used to list the project's other conversations. */
  projectPath: string | null;
  /** Tabs of the current project, in display order. */
  visible: TerminalEntry[];
  activeId: string | null;
  onNewSession: (skipPermissions: boolean) => void;
  skipPermissions: boolean;
  onToggleSkipPermissions: (value: boolean) => void;
  /** All projects (targets of "Déplacer vers…"). */
  projects: Project[];
  /** Move a conversation tab to another project (rejects with a message). */
  onMoveToProject: (termId: string, projectId: string) => Promise<void>;
}

/** Name shown for a tab; unnamed sessions fall back to their short id,
 *  like the chat header does. */
function tabLabel(t: TerminalEntry): string {
  if (t.label.trim()) return t.label;
  return t.sessionId ? `Session ${t.sessionId.slice(0, 8)}` : 'Nouvelle session';
}

/** Tab title shown for an on-disk conversation that has no name yet. */
function titleFromFirstMessage(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'Conversation';
  return flat.length > 40 ? `${flat.slice(0, 40).trimEnd()}…` : flat;
}

export function SessionTabs({
  terminals,
  projectId,
  projectPath,
  visible,
  activeId,
  onNewSession,
  skipPermissions,
  onToggleSkipPermissions,
  projects,
  onMoveToProject,
}: Props): React.JSX.Element {
  const agentStatus = useAgentStatus();
  // Phone (folded / narrow): one "current session ▾" button opening a list
  // instead of a row of tabs that mostly scrolls out of sight.
  const compact = useFormFactor() === 'phone';
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previews, setPreviews] = useState<Map<string, SessionPreview>>(new Map());

  const closed = terminals.closedForProject(projectId);

  // Last-message times for the open tabs (and closed ones when the
  // history panel is showing them).
  const probeItems = useMemo(() => {
    const items = visible
      .filter((t) => t.kind === 'claude' && t.sessionId)
      .map((t) => ({ cwd: t.cwd, session_id: t.sessionId as string }));
    if (historyOpen) {
      for (const c of closed) items.push({ cwd: c.cwd, session_id: c.session_id });
    }
    return items;
  }, [visible, closed, historyOpen]);
  const probeKey = probeItems.map((i) => i.session_id).join('|');
  const probeRef = useRef(probeItems);
  useEffect(() => {
    probeRef.current = probeItems;
  }, [probeItems]);
  useEffect(() => {
    let cancelled = false;
    const probe = async (): Promise<void> => {
      if (probeRef.current.length === 0) return;
      try {
        const out = await sessionPreviews(probeRef.current);
        if (!cancelled) setPreviews(new Map(out.map((p) => [p.session_id, p])));
      } catch (e) {
        console.error('[Elyone][SessionTabs] previews failed', e);
      }
    };
    void probe();
    const iv = setInterval(() => void probe(), TAB_ORDER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [probeKey]);

  // Browser-like shortcuts. Skipped inside an xterm (Ctrl+W deletes a
  // word in a shell).
  const stateRef = useRef({ activeId, projectId });
  useEffect(() => {
    stateRef.current = { activeId, projectId };
  }, [activeId, projectId]);
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent): void {
      if (!ev.ctrlKey || ev.altKey || ev.metaKey) return;
      const target = ev.target as Element | null;
      if (target?.closest?.('.xterm')) return;
      const { activeId: aid, projectId: pid } = stateRef.current;
      if (!ev.shiftKey && (ev.key === 'w' || ev.key === 'W') && aid) {
        ev.preventDefault();
        void terminals.close(aid);
      } else if (ev.shiftKey && (ev.key === 't' || ev.key === 'T') && pid) {
        ev.preventDefault();
        terminals.reopenLastClosed(pid);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [terminals]);

  // Most recent message first. A conversation with no transcript yet was
  // just created → newest of all. Shells (no transcript) go last. Ties keep
  // the existing order (Array.prototype.sort is stable).
  const ordered = useMemo(() => {
    const key = (t: TerminalEntry): number => {
      if (t.kind !== 'claude' || !t.sessionId) return -1;
      const m = previews.get(t.sessionId)?.mtime_ms ?? 0;
      return m > 0 ? m : Number.MAX_SAFE_INTEGER;
    };
    return [...visible].sort((x, y) => key(y) - key(x));
  }, [visible, previews]);

  // ── Right-click → move to another project ───────────────────────────
  const [moveMenu, setMoveMenu] = useState<{ termId: string; x: number; y: number } | null>(null);
  const [moveFilter, setMoveFilter] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const closeMoveMenu = (): void => {
    setMoveMenu(null);
    setMoveFilter('');
    setMoveError(null);
  };
  useEffect(() => {
    if (!moveMenu) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') closeMoveMenu();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveMenu]);

  const statusText = (t: TerminalEntry): { text: string; working: boolean } => {
    if (t.kind !== 'claude') return { text: 'Terminal', working: false };
    if (agentStatus.status(t.agentId) === 'working') return { text: 'En cours…', working: true };
    if (t.id.startsWith('ghost:')) return { text: 'En pause', working: false };
    return { text: 'Prêt', working: false };
  };

  const commitRename = (id: string): void => {
    terminals.rename(id, editingValue);
    setEditingId(null);
  };

  const avatar = (t: TerminalEntry): React.JSX.Element =>
    t.kind === 'claude' ? (
      <span className="dt-tab-avatar" style={{ background: avatarColor(t.sessionId ?? t.id) }} aria-hidden>
        {initials(tabLabel(t))}
      </span>
    ) : (
      <span className="dt-tab-avatar dt-tab-avatar--shell" aria-hidden>
        <SquareTerminal size="1em" strokeWidth={1.75} />
      </span>
    );

  const current = ordered.find((t) => t.id === activeId) ?? ordered[0];

  return (
    <div className="dt-tabs">
      {compact && (
        <div className="dt-tabs-picker">
          <button
            type="button"
            className="dt-tabs-picker-btn"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((o) => !o)}
          >
            {current ? (
              <>
                {avatar(current)}
                <span className="dt-tab-text">
                  <span className="dt-tab-title">{tabLabel(current)}</span>
                  <span className="dt-tab-sub">
                    <span className={statusText(current).working ? 'dt-conv-status is-working' : undefined}>
                      {statusText(current).text}
                    </span>
                    {` · ${ordered.length} session${ordered.length > 1 ? 's' : ''}`}
                  </span>
                </span>
              </>
            ) : (
              <span className="dt-tab-title">Aucune session</span>
            )}
            <ChevronDown size="1.1em" strokeWidth={2} aria-hidden />
          </button>
          {pickerOpen && (
            <>
              <div className="dt-move-backdrop" onClick={() => setPickerOpen(false)} />
              <div className="dt-tabs-picker-list" role="listbox">
                {ordered.map((t) => {
                  const st = statusText(t);
                  const when = t.sessionId ? formatWhen(previews.get(t.sessionId)?.mtime_ms ?? 0) : '';
                  return (
                    <div
                      key={t.id}
                      role="option"
                      aria-selected={t.id === current?.id}
                      className={`dt-tab${t.id === current?.id ? ' is-active' : ''}`}
                      onClick={() => {
                        terminals.setActive(t.id);
                        setPickerOpen(false);
                      }}
                    >
                      {avatar(t)}
                      <span className="dt-tab-text">
                        <span className="dt-tab-title">{tabLabel(t)}</span>
                        <span className="dt-tab-sub">
                          <span className={st.working ? 'dt-conv-status is-working' : undefined}>{st.text}</span>
                          {when ? ` · ${when}` : ''}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="dt-tab-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          void terminals.close(t.id);
                        }}
                        aria-label={`Fermer ${tabLabel(t)}`}
                      >
                        <X size="0.9em" strokeWidth={2} aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
      <div className="dt-tabs-scroll" style={compact ? { display: 'none' } : undefined}>
        {ordered.map((t) => {
          const isActive = t.id === activeId;
          const st = statusText(t);
          const when = t.sessionId ? formatWhen(previews.get(t.sessionId)?.mtime_ms ?? 0) : '';
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              className={`dt-tab${isActive ? ' is-active' : ''}`}
              onClick={() => {
                if (editingId !== t.id) terminals.setActive(t.id);
              }}
              onContextMenu={(e) => {
                if (t.kind !== 'claude' || !t.sessionId) return;
                e.preventDefault();
                setMoveError(null);
                setMoveMenu({ termId: t.id, x: e.clientX, y: e.clientY });
              }}
              onAuxClick={(e) => {
                // Middle click closes, like a browser tab.
                if (e.button === 1) void terminals.close(t.id);
              }}
              onDoubleClick={() => {
                setEditingId(t.id);
                setEditingValue(t.label);
              }}
              onKeyDown={(e) => {
                if (editingId === t.id) return;
                if (e.key === 'Enter' || e.key === ' ') terminals.setActive(t.id);
              }}
              title={`${tabLabel(t)}\n(double-clic : renommer · clic droit : déplacer vers un autre projet)`}
            >
              {t.kind === 'claude' ? (
                <span
                  className="dt-tab-avatar"
                  style={{ background: avatarColor(t.sessionId ?? t.id) }}
                  aria-hidden
                >
                  {initials(tabLabel(t))}
                </span>
              ) : (
                <span className="dt-tab-avatar dt-tab-avatar--shell" aria-hidden>
                  <SquareTerminal size="1em" strokeWidth={1.75} />
                </span>
              )}
              <span className="dt-tab-text">
                {editingId === t.id ? (
                  <input
                    autoFocus
                    className="dt-tab-rename"
                    value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(t.id);
                      else if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <span className="dt-tab-title">{tabLabel(t)}</span>
                )}
                <span className="dt-tab-sub">
                  <span className={st.working ? 'dt-conv-status is-working' : undefined}>{st.text}</span>
                  {when ? ` · ${when}` : ''}
                </span>
              </span>
              <button
                type="button"
                className="dt-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  void terminals.close(t.id);
                }}
                aria-label={`Fermer ${tabLabel(t)}`}
                title="Fermer (Ctrl+W) — rouvrable depuis l'historique"
              >
                <X size="0.9em" strokeWidth={2} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>

      {moveMenu && (
        <>
          <div className="dt-move-backdrop" onClick={closeMoveMenu} onContextMenu={(e) => { e.preventDefault(); closeMoveMenu(); }} />
          <div
            className="dt-move-menu"
            role="menu"
            style={{ left: Math.min(moveMenu.x, window.innerWidth - 320), top: moveMenu.y }}
          >
            <div className="dt-move-head">
              <FolderInput size="1em" strokeWidth={1.75} aria-hidden />
              <span>Déplacer vers…</span>
            </div>
            <input
              autoFocus
              className="dt-move-filter"
              value={moveFilter}
              onChange={(e) => setMoveFilter(e.target.value)}
              placeholder="Filtrer les projets…"
              aria-label="Filtrer les projets"
            />
            <div className="dt-move-list">
              {projects
                .filter((p) => p.id !== projectId)
                .filter((p) => !moveFilter.trim() || matches(p.name, moveFilter.trim()))
                .sort((x, y) => x.name.localeCompare(y.name, 'fr'))
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitem"
                    disabled={moveBusy}
                    onClick={() => {
                      setMoveBusy(true);
                      setMoveError(null);
                      onMoveToProject(moveMenu.termId, p.id)
                        .then(() => closeMoveMenu())
                        .catch((e: unknown) => setMoveError(e instanceof Error ? e.message : String(e)))
                        .finally(() => setMoveBusy(false));
                    }}
                  >
                    <span className="dt-move-avatar" style={{ background: avatarColor(p.id) }} aria-hidden>
                      {initials(p.name)}
                    </span>
                    <span className="dt-move-name">{p.name}</span>
                  </button>
                ))}
            </div>
            <div className="dt-move-note">
              {moveBusy
                ? 'Déplacement en cours…'
                : moveError
                  ? `Échec : ${moveError}`
                  : "L'agent est arrêté puis reprend dans le dossier du projet choisi. Tes fichiers ne bougent pas."}
            </div>
          </div>
        </>
      )}

      <div className="dt-tabs-actions">
        <div className="dt-tabs-split">
          <button
            type="button"
            className="dt-tabs-btn dt-tabs-btn--primary"
            onClick={() => onNewSession(skipPermissions)}
            disabled={!projectId}
            title={skipPermissions ? 'Nouvelle session (sans demandes de permission)' : 'Nouvelle session'}
          >
            <Plus size="1.1em" strokeWidth={2} aria-hidden />
            {!compact && <span>Session</span>}
          </button>
          <button
            type="button"
            className="dt-tabs-btn dt-tabs-btn--primary dt-tabs-btn--chevron"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Options de nouvelle session"
          >
            <ChevronDown size="1em" strokeWidth={2} aria-hidden />
          </button>
          {menuOpen && (
            <div className="dt-tabs-menu" onMouseLeave={() => setMenuOpen(false)}>
              <label className="dt-tabs-menu-row">
                <input
                  type="checkbox"
                  checked={skipPermissions}
                  onChange={(e) => onToggleSkipPermissions(e.target.checked)}
                />
                <span>
                  Sans demandes de permission
                  <small>L&apos;agent agit sans te demander confirmation (--dangerously-skip-permissions)</small>
                </span>
              </label>
            </div>
          )}
        </div>
        <button
          type="button"
          className={`dt-tabs-btn${historyOpen ? ' is-on' : ''}`}
          onClick={() => setHistoryOpen((v) => !v)}
          disabled={!projectId}
          title="Sessions fermées et autres conversations (Ctrl+Maj+T : rouvrir la dernière)"
        >
          <History size="1.1em" strokeWidth={1.75} aria-hidden />
          {!compact && <span>Historique</span>}
          {closed.length > 0 && <span className="dt-tabs-badge">{closed.length}</span>}
        </button>
      </div>

      {historyOpen && projectId && (
        <HistoryPanel
          terminals={terminals}
          projectId={projectId}
          projectPath={projectPath}
          visible={visible}
          previews={previews}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}

function HistoryPanel({
  terminals,
  projectId,
  projectPath,
  visible,
  previews,
  onClose,
}: {
  terminals: UseTerminalsResult;
  projectId: string;
  projectPath: string | null;
  visible: TerminalEntry[];
  previews: Map<string, SessionPreview>;
  onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [others, setOthers] = useState<ResumableSession[] | null>(null);
  const closed = terminals.closedForProject(projectId);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    listResumableSessions(projectPath)
      .then((list) => {
        if (!cancelled) setOthers(list);
      })
      .catch((e) => {
        console.error('[Elyone][SessionTabs] listResumableSessions failed', e);
        if (!cancelled) setOthers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = query.trim();
  const closedShown = closed.filter(
    (c) => !q || matches(c.label, q) || matches(previews.get(c.session_id)?.last_text ?? '', q),
  );
  const known = new Set<string>([
    ...closed.map((c) => c.session_id),
    ...visible.map((t) => t.sessionId ?? ''),
  ]);
  const othersShown = (others ?? [])
    .filter((o) => !known.has(o.session_id) && o.user_turn_count > 0)
    .filter((o) => !q || matches(o.first_user_text, q));

  return (
    <div className="dt-history" role="dialog" aria-label="Historique des sessions">
      <div className="dt-history-head">
        <strong>Historique</strong>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrer…"
          aria-label="Filtrer l'historique"
        />
        <button type="button" className="dt-tab-close is-visible" onClick={onClose} aria-label="Fermer">
          <X size="1em" strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div className="dt-history-body">
        <div className="dt-history-section">Sessions fermées</div>
        {closedShown.length === 0 && (
          <div className="dt-history-empty">
            {closed.length === 0 ? 'Aucune session fermée pour ce projet.' : 'Aucun résultat.'}
          </div>
        )}
        {closedShown.map((c) => {
          const p = previews.get(c.session_id);
          return (
            <div
              key={c.session_id}
              role="button"
              tabIndex={0}
              className="dt-history-row"
              onClick={() => {
                terminals.reopen(projectId, c.session_id);
                onClose();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  terminals.reopen(projectId, c.session_id);
                  onClose();
                }
              }}
              title="Rouvrir avec toute la conversation"
            >
              <span className="dt-tab-avatar" style={{ background: avatarColor(c.session_id) }} aria-hidden>
                {initials(c.label)}
              </span>
              <span className="dt-tab-text">
                <span className="dt-history-line">
                  <span className="dt-tab-title">{c.label}</span>
                  <span className="dt-history-when">fermée {formatWhen(c.closed_at_ms)}</span>
                </span>
                <span className="dt-tab-sub">{p?.last_text || 'Conversation conservée'}</span>
              </span>
              <button
                type="button"
                className="dt-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  terminals.forgetClosed(projectId, c.session_id);
                }}
                aria-label={`Retirer ${c.label} de la liste`}
                title="Retirer de la liste (la conversation reste sur le disque)"
              >
                <X size="0.9em" strokeWidth={2} aria-hidden />
              </button>
            </div>
          );
        })}

        <div className="dt-history-section">Autres conversations du projet</div>
        {others === null && <div className="dt-history-empty">Chargement…</div>}
        {others !== null && othersShown.length === 0 && (
          <div className="dt-history-empty">Aucune autre conversation.</div>
        )}
        {othersShown.map((o) => {
          const title = titleFromFirstMessage(o.first_user_text);
          return (
            <div
              key={o.session_id}
              role="button"
              tabIndex={0}
              className="dt-history-row"
              onClick={() => {
                if (projectPath) terminals.openTranscript(projectId, projectPath, o.session_id, title);
                onClose();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && projectPath) {
                  terminals.openTranscript(projectId, projectPath, o.session_id, title);
                  onClose();
                }
              }}
              title="Ouvrir cette conversation dans un onglet"
            >
              <span className="dt-tab-avatar dt-tab-avatar--muted" aria-hidden>
                {initials(title)}
              </span>
              <span className="dt-tab-text">
                <span className="dt-history-line">
                  <span className="dt-tab-title">{title}</span>
                  <span className="dt-history-when">{formatWhen(o.modified_ms)}</span>
                </span>
                <span className="dt-tab-sub">
                  {o.user_turn_count} échange{o.user_turn_count > 1 ? 's' : ''}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
