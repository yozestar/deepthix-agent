/* eslint-disable deepthix/no-inline-colors */
// SCHEDULE pane: declare a target session + a prompt + a cadence and let
// the Rust scheduler thread fire it on time.
//
// Layout:
//   ┌─────────────────────────────────────────────────────────┐
//   │ + New job                                       Refresh │
//   ├─────────────────────────────────────────────────────────┤
//   │  list of jobs (one row per job, expandable for editing) │
//   └─────────────────────────────────────────────────────────┘
//
// Cadences exposed to the UI:
//   - "once" → user picks a date+time
//   - "interval" → user picks N + unit (min / hour / day)
// Cron is NOT in v1 — wait for a real ask.

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { UseTerminalsResult } from '../hooks/useTerminals';
import {
  type Cadence,
  createSchedule as cmdCreateSchedule,
  deleteSchedule as cmdDeleteSchedule,
  listSchedules as cmdListSchedules,
  runScheduleNow as cmdRunScheduleNow,
  type Schedule,
  updateSchedule as cmdUpdateSchedule,
} from '../tauri/commands';

interface Props {
  terminals: UseTerminalsResult;
}

type IntervalUnit = 'minute' | 'hour' | 'day';

interface NewJobDraft {
  name: string;
  target_session_id: string;
  target_project_id: string;
  prompt: string;
  cadence_kind: 'once' | 'interval';
  // Once: pick a local date+time, ISO string. Stored as datetime-local.
  once_at_local: string;
  // Interval: number + unit (converted to seconds at submit).
  interval_n: number;
  interval_unit: IntervalUnit;
}

const UNIT_TO_SECONDS: Record<IntervalUnit, number> = {
  minute: 60,
  hour: 3600,
  day: 86_400,
};

const SECONDS_TO_LARGEST_UNIT = (s: number): { n: number; unit: IntervalUnit } => {
  if (s % UNIT_TO_SECONDS.day === 0) return { n: s / UNIT_TO_SECONDS.day, unit: 'day' };
  if (s % UNIT_TO_SECONDS.hour === 0) return { n: s / UNIT_TO_SECONDS.hour, unit: 'hour' };
  return { n: Math.max(1, Math.round(s / UNIT_TO_SECONDS.minute)), unit: 'minute' };
};

function emptyDraft(defaultProjectId: string, defaultSessionId: string): NewJobDraft {
  // Default the once-at picker to "now + 5 min" so the UI shows
  // something realistic without forcing the user to type a date.
  const future = new Date(Date.now() + 5 * 60 * 1000);
  const localIso = toLocalDatetimeInputValue(future);
  return {
    name: '',
    target_session_id: defaultSessionId,
    target_project_id: defaultProjectId,
    prompt: '',
    cadence_kind: 'interval',
    once_at_local: localIso,
    interval_n: 30,
    interval_unit: 'minute',
  };
}

function toLocalDatetimeInputValue(d: Date): string {
  // <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in LOCAL time.
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDatetimeInputValue(v: string): number {
  // Parses "YYYY-MM-DDTHH:mm" as local time, returns UTC epoch ms.
  return new Date(v).getTime();
}

export function SchedulesPane({ terminals }: Props): React.JSX.Element {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);

  // Pick the first claude session we know of as a sane default for the
  // form's target — saves the user from picking blindly.
  const claudeSessions = useMemo(
    () => terminals.terminals.filter((t) => t.kind === 'claude' && t.sessionId),
    [terminals.terminals],
  );
  const defaults = useMemo(() => {
    const first = claudeSessions[0];
    return {
      projectId: first?.projectId ?? '',
      sessionId: first?.sessionId ?? '',
    };
  }, [claudeSessions]);

  const [draft, setDraft] = useState<NewJobDraft>(() =>
    emptyDraft(defaults.projectId, defaults.sessionId),
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const rows = await cmdListSchedules();
      setSchedules(rows);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][SchedulesPane] list failed', e);
      setError(msg);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Re-pull every 10s so the list reflects fires + last_run_ms updates
    // without requiring the user to switch tabs.
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const submitDraft = useCallback(async (): Promise<void> => {
    if (!draft.target_session_id) {
      setError('Pick a session to target');
      return;
    }
    if (!draft.prompt.trim()) {
      setError('Prompt cannot be empty');
      return;
    }
    let cadence: Cadence;
    if (draft.cadence_kind === 'once') {
      const at_ms = fromLocalDatetimeInputValue(draft.once_at_local);
      if (!Number.isFinite(at_ms) || at_ms <= Date.now()) {
        setError('Pick a future date+time');
        return;
      }
      cadence = { kind: 'once', at_ms };
    } else {
      const every_seconds = draft.interval_n * UNIT_TO_SECONDS[draft.interval_unit];
      if (every_seconds < 30) {
        setError('Minimum interval is 30 seconds');
        return;
      }
      cadence = { kind: 'interval', every_seconds };
    }
    try {
      await cmdCreateSchedule({
        name: draft.name.trim() || draft.prompt.slice(0, 40),
        target_session_id: draft.target_session_id,
        target_project_id: draft.target_project_id,
        prompt: draft.prompt,
        cadence,
      });
      setDraft(emptyDraft(defaults.projectId, defaults.sessionId));
      setDraftOpen(false);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][SchedulesPane] create failed', e);
      setError(msg);
    }
  }, [draft, defaults, refresh]);

  const togglePause = useCallback(
    async (s: Schedule): Promise<void> => {
      try {
        await cmdUpdateSchedule({ id: s.id, paused: !s.paused });
        await refresh();
      } catch (e) {
        console.error('[Deepthix][SchedulesPane] toggle pause failed', e);
      }
    },
    [refresh],
  );

  const runNow = useCallback(
    async (s: Schedule): Promise<void> => {
      try {
        await cmdRunScheduleNow(s.id);
        await refresh();
      } catch (e) {
        console.error('[Deepthix][SchedulesPane] run now failed', e);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (s: Schedule): Promise<void> => {
      if (!confirm(`Delete schedule '${s.name || s.prompt.slice(0, 40)}'?`)) return;
      try {
        await cmdDeleteSchedule(s.id);
        await refresh();
      } catch (e) {
        console.error('[Deepthix][SchedulesPane] delete failed', e);
      }
    },
    [refresh],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg)',
        fontFamily: 'var(--font-pixel)',
        color: 'var(--color-text)',
        padding: '12px',
        gap: '12px',
        overflow: 'auto',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: '14px', opacity: 0.85 }}>
          Schedules — {schedules.length} job{schedules.length === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <PixelButton onClick={() => setDraftOpen((v) => !v)} primary={!draftOpen}>
            {draftOpen ? 'Cancel' : '+ New job'}
          </PixelButton>
          <PixelButton onClick={() => void refresh()}>Refresh</PixelButton>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: '6px 10px',
            background: 'var(--color-danger)',
            color: 'var(--color-bg-dark)',
            border: '2px solid var(--color-border)',
            fontSize: '12px',
          }}
        >
          {error}
        </div>
      )}

      {/* New-job form */}
      {draftOpen && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px',
            border: '2px solid var(--color-border)',
            background: 'var(--color-bg-dark)',
          }}
        >
          <Field label="Name (optional)">
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Refresh meta ads"
              style={inputStyle}
            />
          </Field>
          <Field label="Target session">
            <select
              value={draft.target_session_id}
              onChange={(e) => {
                const sid = e.target.value;
                const t = claudeSessions.find((x) => x.sessionId === sid);
                setDraft({
                  ...draft,
                  target_session_id: sid,
                  target_project_id: t?.projectId ?? draft.target_project_id,
                });
              }}
              style={inputStyle}
            >
              {claudeSessions.length === 0 && <option value="">— no claude session yet —</option>}
              {claudeSessions.map((t) => (
                <option key={t.id} value={t.sessionId ?? ''}>
                  {t.label} ({t.cwd.split('/').slice(-2).join('/')})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prompt to send">
            <textarea
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              rows={3}
              placeholder="What do you want claude to do?"
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-pixel)' }}
            />
          </Field>
          <Field label="Cadence">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                value={draft.cadence_kind}
                onChange={(e) =>
                  setDraft({ ...draft, cadence_kind: e.target.value as 'once' | 'interval' })
                }
                style={{ ...inputStyle, width: 'auto' }}
              >
                <option value="interval">Every</option>
                <option value="once">Once at</option>
              </select>
              {draft.cadence_kind === 'interval' ? (
                <>
                  <input
                    type="number"
                    min={1}
                    value={draft.interval_n}
                    onChange={(e) =>
                      setDraft({ ...draft, interval_n: Math.max(1, Number(e.target.value)) })
                    }
                    style={{ ...inputStyle, width: '80px' }}
                  />
                  <select
                    value={draft.interval_unit}
                    onChange={(e) =>
                      setDraft({ ...draft, interval_unit: e.target.value as IntervalUnit })
                    }
                    style={{ ...inputStyle, width: 'auto' }}
                  >
                    <option value="minute">min</option>
                    <option value="hour">h</option>
                    <option value="day">days</option>
                  </select>
                </>
              ) : (
                <input
                  type="datetime-local"
                  value={draft.once_at_local}
                  onChange={(e) => setDraft({ ...draft, once_at_local: e.target.value })}
                  style={inputStyle}
                />
              )}
            </div>
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <PixelButton onClick={() => void submitDraft()} primary>
              Create job
            </PixelButton>
          </div>
        </div>
      )}

      {/* Job list */}
      {schedules.length === 0 ? (
        <div className="dt-empty">
          <div style={{ fontSize: 36, opacity: 0.5 }}>⌛</div>
          <div className="dt-empty-title">No schedules yet</div>
          <div className="dt-empty-sub">
            Click <strong>+ New job</strong> to declare a recurring or one-shot prompt that fires
            into a session automatically.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {schedules.map((s) => (
            <ScheduleRow
              key={s.id}
              schedule={s}
              terminals={terminals}
              onTogglePause={() => void togglePause(s)}
              onRunNow={() => void runNow(s)}
              onDelete={() => void remove(s)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleRow({
  schedule,
  terminals,
  onTogglePause,
  onRunNow,
  onDelete,
}: {
  schedule: Schedule;
  terminals: UseTerminalsResult;
  onTogglePause: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const targetTerm = terminals.terminals.find(
    (t) => t.sessionId === schedule.target_session_id,
  );
  const targetLabel = targetTerm
    ? `${targetTerm.label} — ${targetTerm.cwd.split('/').slice(-2).join('/')}`
    : `(session not open: ${schedule.target_session_id.slice(0, 8)}…)`;
  const cadenceText =
    schedule.cadence.kind === 'once'
      ? `Once at ${formatLocal(schedule.cadence.at_ms)}`
      : `Every ${describeInterval(schedule.cadence.every_seconds)}`;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        background: 'var(--color-bg-dark)',
        border: '2px solid var(--color-border)',
        opacity: schedule.paused ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: '13px' }}>
          {schedule.name || schedule.prompt.slice(0, 40)}
          {schedule.paused && (
            <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.7 }}>(paused)</span>
          )}
        </strong>
        <div style={{ display: 'flex', gap: 6 }}>
          <PixelButton onClick={onRunNow}>Run now</PixelButton>
          <PixelButton onClick={onTogglePause}>{schedule.paused ? 'Resume' : 'Pause'}</PixelButton>
          <PixelButton onClick={onDelete} danger>
            Delete
          </PixelButton>
        </div>
      </div>
      <div style={{ fontSize: '11px', opacity: 0.75 }}>
        <div>Target: {targetLabel}</div>
        <div>{cadenceText}</div>
        <div>
          Next: {formatLocal(schedule.next_run_ms)}
          {schedule.last_run_ms && ` · Last: ${formatLocal(schedule.last_run_ms)}`}
        </div>
      </div>
      <div
        style={{
          fontSize: '12px',
          padding: '6px 8px',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: '80px',
          overflow: 'auto',
        }}
      >
        {schedule.prompt}
      </div>
    </div>
  );
}

function describeInterval(seconds: number): string {
  const { n, unit } = SECONDS_TO_LARGEST_UNIT(seconds);
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function formatLocal(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  border: '2px solid var(--color-border)',
  fontFamily: 'var(--font-pixel)',
  fontSize: '12px',
  width: '100%',
  boxSizing: 'border-box',
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '11px' }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      {children}
    </label>
  );
}

function PixelButton({
  onClick,
  children,
  primary,
  danger,
}: {
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
  danger?: boolean;
}): React.JSX.Element {
  const bg = danger
    ? 'var(--color-danger)'
    : primary
      ? 'var(--color-accent)'
      : 'transparent';
  const fg = primary || danger ? 'var(--color-bg-dark)' : 'inherit';
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 10px',
        background: bg,
        color: fg,
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        fontFamily: 'var(--font-pixel)',
        fontSize: '12px',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
