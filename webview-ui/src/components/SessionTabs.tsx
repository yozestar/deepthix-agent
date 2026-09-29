// Session tab strip — card-style tabs in the spirit of the project sidebar:
// round avatar, bold name, status + last-message time underneath, close
// button on hover. Ends with "+" (new session, with a menu for the
// "skip permissions" variant) and "Historique" (closed sessions + other
// conversations of the project, reopenable with their full history).
//
// Shortcuts (browser-like): Ctrl+W closes the active tab, Ctrl+Shift+T
// reopens the last closed one.

import { ChevronDown, History, Plus, SquareTerminal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { SIDEBAR_PREVIEW_POLL_MS } from '../constants';
import { avatarColor, formatWhen, initials, matches } from '../conversationUtils';
import { useAgentStatus } from '../hooks/useAgentStatus';
import type { TerminalEntry, UseTerminalsResult } from '../hooks/useTerminals';
import {
  listResumableSessions,
  type ResumableSession,
  type SessionPreview,
  sessionPreviews,
} from '../tauri/commands';

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
}: Props): React.JSX.Element {
  const agentStatus = useAgentStatus();
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
    const iv = setInterval(() => void probe(), SIDEBAR_PREVIEW_POLL_MS);
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

  return (
    <div className="dt-tabs">
      <div className="dt-tabs-scroll">
        {visible.map((t) => {
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
              onClick={() => editingId !== t.id && terminals.setActive(t.id)}
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
              title={`${t.label}\n(double-clic pour renommer)`}
            >
              {t.kind === 'claude' ? (
                <span
                  className="dt-tab-avatar"
                  style={{ background: avatarColor(t.sessionId ?? t.id) }}
                  aria-hidden
                >
                  {initials(t.label)}
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
                  <span className="dt-tab-title">{t.label}</span>
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
                aria-label={`Fermer ${t.label}`}
                title="Fermer (Ctrl+W) — rouvrable depuis l'historique"
              >
                <X size="0.9em" strokeWidth={2} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>

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
            <span>Session</span>
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
          <span>Historique</span>
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
