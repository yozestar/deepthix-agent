// Project board, top of OVERVIEW: what is left to do in this project,
// grouped by the conversation each task came from. A click on a group
// reopens that conversation; the box ticks a task done.

import { Check, ChevronDown, ChevronRight, MessagesSquare } from 'lucide-react';
import { useState } from 'react';

import { useFormFactor } from '../hooks/useFormFactor';
import { refreshTasks, useTasks } from '../hooks/useTasks';
import type { TerminalEntry } from '../hooks/useTerminals';
import { BUCKET_COLOR, BUCKET_LABEL, bucketOf, classifyTasks, daysSince, dueLabel } from '../tasks';
import { type Task, taskSetDone } from '../tauri/commands';

const COLLAPSE_KEY = 'elyone.overview.tasksCollapsed';
const NO_CONVERSATION = '__none__';

interface Group {
  key: string;
  label: string;
  sessionId: string | null;
  tasks: Task[];
  /** Most urgent bucket rank in the group (lower = more urgent). */
  rank: number;
}

interface Props {
  projectId: string;
  terminals: TerminalEntry[];
  onOpenConversation: (projectId: string, sessionId: string, label: string) => void;
  onOpenTasks: () => void;
}

export function ProjectTasksPanel({
  projectId,
  terminals,
  onOpenConversation,
  onOpenTasks,
}: Props): React.JSX.Element | null {
  const touch = useFormFactor() !== 'desktop';
  const { tasks, loaded } = useTasks();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const [now] = useState(() => Date.now());
  const [doneCount, setDoneCount] = useState(0);

  const mine = tasks.filter((t) => t.project_id === projectId);
  const open = mine.filter((t) => t.status !== 'done');
  if (!loaded) return null;

  const order = ['overdue', 'waiting', 'today', 'stale', 'week', 'later', 'done'];
  const labelOf = (sid: string | null, t: Task): string => {
    if (!sid) return 'Sans conversation';
    return terminals.find((x) => x.sessionId === sid)?.label || t.session_label || 'Conversation';
  };
  const byKey = new Map<string, Group>();
  for (const t of open) {
    const key = t.session_id ?? NO_CONVERSATION;
    const g = byKey.get(key) ?? { key, label: labelOf(t.session_id, t), sessionId: t.session_id, tasks: [], rank: 99 };
    g.tasks.push(t);
    g.rank = Math.min(g.rank, order.indexOf(bucketOf(t, now)));
    byKey.set(key, g);
  }
  const groups = [...byKey.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  for (const g of groups) {
    const c = classifyTasks(g.tasks, now);
    g.tasks = order.flatMap((b) => c[b as keyof typeof c]);
  }
  const urgent = open.filter((t) => ['overdue', 'waiting', 'today'].includes(bucketOf(t, now))).length;

  const toggle = (): void => {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1');
      return !v;
    });
  };

  return (
    <div
      style={{
        border: '2px solid var(--color-border)',
        background: 'var(--color-bg-dark)',
        marginBottom: 12,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: collapsed ? undefined : '45%',
        minHeight: 0,
        flexShrink: 0,
        fontFamily: 'var(--font-pixel)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px' }}>
        <button
          type="button"
          onClick={toggle}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'none',
            border: 'none',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-pixel)',
            fontSize: '0.8125rem',
            fontWeight: 'bold',
            cursor: 'pointer',
            minHeight: touch ? 44 : 28,
            padding: 0,
          }}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          RESTE À FAIRE · {open.length}
        </button>
        {urgent > 0 && (
          <span style={{ fontSize: '0.6875rem', color: 'var(--color-danger)' }}>{urgent} urgente(s)</span>
        )}
        {doneCount > 0 && (
          <span style={{ fontSize: '0.6875rem', color: 'var(--color-status-success)' }}>
            {doneCount} terminée(s) à l’instant
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onOpenTasks}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-accent)',
            fontFamily: 'var(--font-pixel)',
            fontSize: '0.75rem',
            cursor: 'pointer',
            minHeight: touch ? 44 : 28,
          }}
        >
          Toutes mes tâches →
        </button>
      </div>
      {!collapsed && (
        <div style={{ overflow: 'auto', padding: '0 10px 10px', minHeight: 0 }}>
          {open.length === 0 && (
            <div style={{ fontSize: '0.75rem', opacity: 0.6, padding: '4px 0 6px' }}>
              Rien en attente sur ce projet. Tape /tache dans une conversation pour en ajouter.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.key} style={{ marginTop: 8 }}>
              <button
                type="button"
                disabled={!g.sessionId}
                onClick={() => g.sessionId && onOpenConversation(projectId, g.sessionId, g.label)}
                title={g.sessionId ? 'Ouvrir la conversation' : undefined}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: g.sessionId ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  fontFamily: 'var(--font-pixel)',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: g.sessionId ? 'pointer' : 'default',
                  minHeight: touch ? 40 : 24,
                  textAlign: 'left',
                }}
              >
                <MessagesSquare size={13} aria-hidden /> {g.label} · {g.tasks.length}
              </button>
              {g.tasks.map((t) => {
                const b = bucketOf(t, now);
                const facts = [
                  BUCKET_LABEL[b].toLowerCase(),
                  t.due ? `échéance ${dueLabel(t.due, now)}` : '',
                  t.waiting_on ? `${t.waiting_on} attend depuis ${daysSince(t.created_ms, now)} j` : '',
                ].filter(Boolean);
                return (
                  <div
                    key={t.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      borderLeft: `3px solid ${BUCKET_COLOR[b]}`,
                      padding: '2px 0 2px 8px',
                      marginTop: 4,
                    }}
                  >
                    <button
                      type="button"
                      aria-label={`Marquer terminée : ${t.title}`}
                      title="Terminée"
                      onClick={() =>
                        void taskSetDone(t.id, true)
                          .then(() => setDoneCount((n) => n + 1))
                          .then(refreshTasks)
                      }
                      style={{
                        width: touch ? 36 : 20,
                        height: touch ? 36 : 20,
                        flexShrink: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--color-bg)',
                        border: '2px solid var(--color-border)',
                        color: 'var(--color-text-muted)',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      <Check size={12} aria-hidden style={{ opacity: 0.25 }} />
                    </button>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '0.8125rem' }}>{t.title}</div>
                      <div style={{ fontSize: '0.6875rem', opacity: 0.65 }}>{facts.join(' · ')}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
