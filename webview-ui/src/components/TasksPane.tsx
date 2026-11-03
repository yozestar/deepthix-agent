// TASKS pane ("Mes tâches"): everything left to do, across every project,
// grouped by urgency — late, someone waiting, today, untouched for two
// weeks, this week, later. Tasks come from the quick-add field, the /tache
// command and the agent itself (task_add tool). Storage: ~/.elyone/tasks.json.

import { Check, ChevronDown, ChevronRight, Clock, Plus, Trash2, User } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { TASKS_FILTER_KEY } from '../constants';
import { useFormFactor } from '../hooks/useFormFactor';
import type { useProjects } from '../hooks/useProjects';
import { refreshTasks, useTasks } from '../hooks/useTasks';
import {
  type Bucket,
  BUCKET_COLOR,
  BUCKET_LABEL,
  BUCKETS,
  classifyTasks,
  daysSince,
  dueLabel,
  parseQuickTask,
} from '../tasks';
import {
  type Task,
  taskDelete,
  taskSave,
  taskSetDone,
} from '../tauri/commands';
import type { Mode } from './TopTabs';

const ALL = '__all__';

interface Props {
  projects: ReturnType<typeof useProjects>;
  onChangeMode: (m: Mode) => void;
  /** Jump to the conversation a task came from. */
  onOpenConversation: (projectId: string, sessionId: string, label: string) => void;
  /** Current tab name of a conversation, when it is a tab. */
  conversationLabel?: (sessionId: string) => string | null;
}

const NOW_TICK_MS = 60_000;

export function TasksPane({
  projects,
  onChangeMode,
  onOpenConversation,
  conversationLabel,
}: Props): React.JSX.Element {
  const touch = useFormFactor() !== 'desktop';
  const { tasks, loaded, error: loadError } = useTasks();
  const [opError, setError] = useState<string | null>(null);
  const error = opError ?? loadError;
  const [filter, setFilter] = useState<string>(() => localStorage.getItem(TASKS_FILTER_KEY) ?? ALL);
  const [draft, setDraft] = useState('');
  const [draftProject, setDraftProject] = useState<string>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const projectName = useMemo(() => {
    const m = new Map(projects.projects.map((p) => [p.id, p.name]));
    return (id: string): string => m.get(id) ?? 'Projet inconnu';
  }, [projects.projects]);

  // "Today" / "N days ago" move with the clock, not only with the data.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => localStorage.setItem(TASKS_FILTER_KEY, filter), [filter]);

  // Quick add goes to the filtered project, else the active one.
  const targetProject =
    draftProject || (filter !== ALL ? filter : (projects.activeProjectId ?? ''));

  const run = useCallback(
    async (op: () => Promise<unknown>): Promise<void> => {
      try {
        await op();
        setError(null);
        setNow(Date.now());
        await refreshTasks();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const onAdd = (): void => {
    const q = parseQuickTask(draft, Date.now());
    if (!q.title) return;
    if (!targetProject) {
      setError('Choisis un projet pour cette tâche');
      return;
    }
    setDraft('');
    void run(() =>
      taskSave({ project_id: targetProject, title: q.title, due: q.due, waiting_on: q.waiting_on }),
    );
  };

  const visible = filter === ALL ? tasks : tasks.filter((t) => t.project_id === filter);
  const groups = classifyTasks(visible, now);
  const openCount = visible.length - groups.done.length;
  const btnSize = touch ? 44 : 28;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-pixel)',
        color: 'var(--color-text)',
        background: 'var(--color-bg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
        }}
      >
        <span style={{ fontWeight: 'bold', color: 'var(--color-accent)', letterSpacing: '0.06em' }}>
          MES TÂCHES
        </span>
        <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>{openCount} à faire</span>
        <span style={{ flex: 1 }} />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Projet"
          style={selectStyle(touch)}
        >
          <option value={ALL}>Tous les projets</option>
          {projects.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          padding: '10px 14px',
          borderBottom: '2px solid var(--color-border)',
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Nouvelle tâche…  @client  07/11"
          aria-label="Nouvelle tâche"
          style={{ ...inputStyle(touch), flex: '1 1 220px' }}
        />
        {filter === ALL && (
          <select
            value={targetProject}
            onChange={(e) => setDraftProject(e.target.value)}
            aria-label="Projet de la nouvelle tâche"
            style={selectStyle(touch)}
          >
            <option value="">Projet…</option>
            {projects.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button type="submit" style={primaryBtn(touch)} aria-label="Ajouter">
          <Plus size={16} /> Ajouter
        </button>
        <div style={{ flexBasis: '100%', fontSize: '0.6875rem', opacity: 0.6 }}>
          @Nom = quelqu’un attend · date : 07/11, demain, aujourd’hui · l’agent ajoute aussi
          ce qui reste à faire
        </div>
      </form>

      {error && (
        <div style={{ padding: '6px 14px', background: 'var(--color-danger)', color: 'var(--color-on-accent)', fontSize: '0.75rem' }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 14px 24px' }}>
        {loaded && openCount === 0 && (
          <div style={{ opacity: 0.6, fontSize: '0.8125rem', padding: '16px 0' }}>
            Rien en attente. Ajoute une tâche ci-dessus, ou tape /tache dans une conversation.
          </div>
        )}
        {BUCKETS.map((b) => {
          const list = groups[b];
          if (list.length === 0) return null;
          const collapsed = b === 'done' && !showDone;
          return (
            <section key={b} style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={b === 'done' ? () => setShowDone((v) => !v) : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'none',
                  border: 'none',
                  padding: '4px 0',
                  color: BUCKET_COLOR[b],
                  fontFamily: 'var(--font-pixel)',
                  fontSize: '0.75rem',
                  fontWeight: 'bold',
                  letterSpacing: '0.06em',
                  cursor: b === 'done' ? 'pointer' : 'default',
                  minHeight: touch ? 36 : undefined,
                }}
              >
                {b === 'done' && (collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />)}
                {BUCKET_LABEL[b].toUpperCase()} · {list.length}
              </button>
              {!collapsed &&
                list.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    bucket={b}
                    now={now}
                    touch={touch}
                    btnSize={btnSize}
                    project={filter === ALL ? projectName(t.project_id) : null}
                    open={openId === t.id}
                    onToggleOpen={() => setOpenId((id) => (id === t.id ? null : t.id))}
                    onDone={(done) => void run(() => taskSetDone(t.id, done))}
                    onDelete={() => void run(() => taskDelete(t.id))}
                    onSave={(patch) =>
                      void run(() => taskSave({ id: t.id, project_id: t.project_id, ...patch }))
                    }
                    conversation={
                      t.session_id ? (conversationLabel?.(t.session_id) ?? (t.session_label || 'Conversation')) : null
                    }
                    onOpenConversation={() =>
                      t.session_id &&
                      onOpenConversation(t.project_id, t.session_id, conversationLabel?.(t.session_id) ?? t.session_label)
                    }
                    onOpenProject={() => {
                      void projects.switchProject(t.project_id);
                      onChangeMode('sessions');
                    }}
                  />
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

interface RowProps {
  task: Task;
  bucket: Bucket;
  now: number;
  touch: boolean;
  btnSize: number;
  project: string | null;
  open: boolean;
  onToggleOpen: () => void;
  onDone: (done: boolean) => void;
  onDelete: () => void;
  onSave: (patch: { title: string; notes: string; due: string | null; waiting_on: string | null }) => void;
  onOpenProject: () => void;
  /** Name of the conversation it came from (null: none known). */
  conversation: string | null;
  onOpenConversation: () => void;
}

function TaskRow(p: RowProps): React.JSX.Element {
  const { task: t, bucket, now, touch, btnSize } = p;
  const done = t.status === 'done';
  const [confirmDelete, setConfirmDelete] = useState(false);
  const facts: string[] = [];
  if (t.due) facts.push(`échéance ${dueLabel(t.due, now)}`);
  if (t.waiting_on) facts.push(`${t.waiting_on} attend depuis ${daysSince(t.created_ms, now)} j`);
  if (bucket === 'stale') facts.push(`sans mouvement depuis ${daysSince(t.updated_ms, now)} j`);
  if (t.source === 'agent') facts.push('noté par l’agent');
  if (p.conversation) facts.push(`💬 ${p.conversation}`);

  return (
    <div
      style={{
        border: '2px solid var(--color-border)',
        borderLeft: `4px solid ${BUCKET_COLOR[bucket]}`,
        background: 'var(--color-bg-dark)',
        marginTop: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px' }}>
        <button
          type="button"
          onClick={() => p.onDone(!done)}
          aria-label={done ? 'Rouvrir' : 'Marquer terminée'}
          title={done ? 'Rouvrir' : 'Terminée'}
          style={{
            width: btnSize,
            height: btnSize,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: done ? 'var(--color-status-success)' : 'var(--color-bg)',
            border: '2px solid var(--color-border)',
            color: 'var(--color-on-accent)',
            cursor: 'pointer',
          }}
        >
          {done && <Check size={14} />}
        </button>
        <button
          type="button"
          onClick={p.onToggleOpen}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'left',
            background: 'none',
            border: 'none',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-pixel)',
            cursor: 'pointer',
            padding: touch ? '8px 0' : '4px 0',
          }}
        >
          <div style={{ fontSize: '0.8125rem', textDecoration: done ? 'line-through' : undefined, opacity: done ? 0.6 : 1 }}>
            {t.title}
          </div>
          {(p.project || facts.length > 0) && (
            <div style={{ fontSize: '0.6875rem', opacity: 0.7, marginTop: 2, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {p.project && <span style={{ color: 'var(--color-accent)' }}>{p.project}</span>}
              {facts.map((f) => (
                <span key={f}>{f}</span>
              ))}
            </div>
          )}
        </button>
      </div>
      {p.open && (
        <TaskEditor
          task={t}
          touch={touch}
          confirmDelete={confirmDelete}
          onDelete={() => (confirmDelete ? p.onDelete() : setConfirmDelete(true))}
          onSave={p.onSave}
          onOpenProject={p.onOpenProject}
          onOpenConversation={p.conversation ? p.onOpenConversation : null}
        />
      )}
    </div>
  );
}

function TaskEditor(p: {
  task: Task;
  touch: boolean;
  confirmDelete: boolean;
  onDelete: () => void;
  onSave: RowProps['onSave'];
  onOpenProject: () => void;
  onOpenConversation: (() => void) | null;
}): React.JSX.Element {
  const { task: t, touch } = p;
  const [title, setTitle] = useState(t.title);
  const [notes, setNotes] = useState(t.notes);
  const [due, setDue] = useState(t.due ?? '');
  const [waiting, setWaiting] = useState(t.waiting_on ?? '');
  const dirty = title !== t.title || notes !== t.notes || due !== (t.due ?? '') || waiting !== (t.waiting_on ?? '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 8px 10px', borderTop: '2px solid var(--color-border)' }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Titre" style={inputStyle(touch)} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <label style={labelStyle}>
          <Clock size={14} />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Échéance" style={inputStyle(touch)} />
        </label>
        <label style={{ ...labelStyle, flex: '1 1 160px' }}>
          <User size={14} />
          <input
            value={waiting}
            onChange={(e) => setWaiting(e.target.value)}
            placeholder="Qui attend ? (client…)"
            aria-label="Qui attend"
            style={{ ...inputStyle(touch), flex: 1 }}
          />
        </label>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes, contexte…"
        aria-label="Notes"
        rows={3}
        style={{ ...inputStyle(touch), resize: 'vertical' }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button
          type="button"
          disabled={!dirty || !title.trim()}
          onClick={() => p.onSave({ title: title.trim(), notes, due: due || '', waiting_on: waiting })}
          style={{ ...primaryBtn(touch), opacity: dirty ? 1 : 0.5 }}
        >
          Enregistrer
        </button>
        {p.onOpenConversation ? (
          <button type="button" onClick={p.onOpenConversation} style={secondaryBtn(touch)}>
            Ouvrir la conversation
          </button>
        ) : (
          <button type="button" onClick={p.onOpenProject} style={secondaryBtn(touch)}>
            Ouvrir le projet
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={p.onDelete}
          style={{ ...secondaryBtn(touch), color: 'var(--color-danger)' }}
        >
          <Trash2 size={14} /> {p.confirmDelete ? 'Confirmer la suppression' : 'Supprimer'}
        </button>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 };

function inputStyle(touch: boolean): React.CSSProperties {
  return {
    background: 'var(--color-bg)',
    color: 'var(--color-text)',
    border: '2px solid var(--color-border)',
    padding: touch ? '10px 8px' : '6px 8px',
    // 16px on touch: iOS zooms the page into smaller inputs.
    fontSize: touch ? '16px' : '0.8125rem',
    fontFamily: 'var(--font-pixel)',
    minWidth: 0,
  };
}

function selectStyle(touch: boolean): React.CSSProperties {
  return { ...inputStyle(touch), maxWidth: 220 };
}

function primaryBtn(touch: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: touch ? '10px 14px' : '6px 12px',
    minHeight: touch ? 44 : undefined,
    background: 'var(--color-accent)',
    color: 'var(--color-on-accent)',
    border: '2px solid var(--color-border)',
    boxShadow: 'var(--shadow-pixel)',
    fontFamily: 'var(--font-pixel)',
    fontSize: '0.75rem',
    cursor: 'pointer',
  };
}

function secondaryBtn(touch: boolean): React.CSSProperties {
  return {
    ...primaryBtn(touch),
    background: 'var(--color-btn-bg)',
    color: 'var(--color-text)',
  };
}
