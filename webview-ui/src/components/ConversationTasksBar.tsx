// Slim bar under the chat header: this conversation's open tasks ("Reste à
// faire · 3", unfolds into the list) and an "Où j'en suis ?" button that
// asks the agent for a status summary (same as typing /point).
// Phone: shown only when there is something to show, to keep the room.

import { Check, ChevronDown, ChevronRight, ClipboardList } from 'lucide-react';
import { useState } from 'react';

import { useFormFactor } from '../hooks/useFormFactor';
import { openTasksOf, refreshTasks, useTasks } from '../hooks/useTasks';
import { BUCKET_COLOR, bucketOf, classifyTasks, dueLabel } from '../tasks';
import { taskSetDone } from '../tauri/commands';

interface Props {
  sessionId: string | null;
  busy: boolean;
  onPoint: () => void;
}

export function ConversationTasksBar({ sessionId, busy, onPoint }: Props): React.JSX.Element | null {
  const touch = useFormFactor() !== 'desktop';
  const { tasks } = useTasks();
  const [open, setOpen] = useState(false);
  const [now] = useState(() => Date.now());

  const mine = openTasksOf(tasks, sessionId);
  if (!sessionId || (touch && mine.length === 0)) return null;
  const g = classifyTasks(mine, now);
  const sorted = (['overdue', 'waiting', 'today', 'stale', 'week', 'later'] as const).flatMap((b) => g[b]);

  const small: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: 'none',
    border: 'none',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-pixel)',
    fontSize: '0.6875rem',
    cursor: 'pointer',
    padding: '0 4px',
    minHeight: touch ? 40 : 24,
  };

  return (
    <div
      className="dt-hide-when-keyboard"
      style={{
        flexShrink: 0,
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-bg-dark)',
        fontFamily: 'var(--font-pixel)',
        padding: '0 8px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={mine.length === 0}
          style={{ ...small, opacity: mine.length === 0 ? 0.55 : 1, cursor: mine.length ? 'pointer' : 'default' }}
          title={mine.length ? 'Voir ce qui reste à faire dans cette conversation' : undefined}
        >
          {mine.length > 0 && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
          <ClipboardList size={13} aria-hidden />
          {mine.length === 0 ? 'Rien en attente' : `Reste à faire · ${mine.length}`}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onPoint}
          disabled={busy}
          title="L’agent résume ce qui est fait, ce qui reste et la prochaine action"
          style={{ ...small, color: 'var(--color-accent)', opacity: busy ? 0.5 : 1 }}
        >
          Où j’en suis ?
        </button>
      </div>
      {open && mine.length > 0 && (
        <div style={{ padding: '0 4px 6px', maxHeight: '30vh', overflow: 'auto' }}>
          {sorted.map((t) => {
            const b = bucketOf(t, now);
            return (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  borderLeft: `3px solid ${BUCKET_COLOR[b]}`,
                  padding: '2px 0 2px 6px',
                  marginTop: 3,
                  fontSize: '0.75rem',
                }}
              >
                <button
                  type="button"
                  aria-label={`Marquer terminée : ${t.title}`}
                  title="Terminée"
                  onClick={() => void taskSetDone(t.id, true).then(refreshTasks)}
                  style={{
                    width: touch ? 36 : 18,
                    height: touch ? 36 : 18,
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
                  <Check size={11} aria-hidden style={{ opacity: 0.25 }} />
                </button>
                <span style={{ minWidth: 0 }}>
                  {t.title}
                  {t.due && <span style={{ opacity: 0.6 }}> · {dueLabel(t.due, now)}</span>}
                  {t.waiting_on && <span style={{ opacity: 0.6 }}> · {t.waiting_on} attend</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
