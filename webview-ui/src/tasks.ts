// Pure task logic (no React, no Tauri): urgency buckets and the quick-add
// syntax. Shared by TasksPane and the /tache slash command.

import { TASK_STALE_DAYS, TASK_WEEK_DAYS } from './constants';
import type { Task } from './tauri/commands';

const DAY_MS = 86_400_000;

export const BUCKETS = ['overdue', 'waiting', 'today', 'stale', 'week', 'later', 'done'] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: 'En retard',
  waiting: 'Quelqu’un attend',
  today: 'Aujourd’hui',
  stale: 'En sommeil',
  week: 'Cette semaine',
  later: 'Plus tard',
  done: 'Terminées',
};

/** Local calendar date as YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n, 12).getTime());
}

/** Most urgent signal first: a late task is "late" even if a client waits. */
export function bucketOf(t: Task, nowMs: number): Bucket {
  if (t.status === 'done') return 'done';
  const today = localDay(nowMs);
  if (t.due && t.due < today) return 'overdue';
  if (t.waiting_on) return 'waiting';
  if (t.due === today) return 'today';
  if (nowMs - t.updated_ms >= TASK_STALE_DAYS * DAY_MS) return 'stale';
  if (t.due && t.due <= addDays(today, TASK_WEEK_DAYS)) return 'week';
  return 'later';
}

/** Whole days since `ms` (0 = today). */
export function daysSince(ms: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - ms) / DAY_MS));
}

/** Tasks grouped by bucket, each group sorted (earliest due, then oldest). */
export function classifyTasks(tasks: Task[], nowMs: number): Record<Bucket, Task[]> {
  const out = Object.fromEntries(BUCKETS.map((b) => [b, [] as Task[]])) as Record<Bucket, Task[]>;
  for (const t of tasks) out[bucketOf(t, nowMs)].push(t);
  const byDueThenAge = (a: Task, b: Task): number =>
    (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.created_ms - b.created_ms;
  for (const b of BUCKETS) out[b].sort(byDueThenAge);
  out.done.sort((a, b) => (b.done_ms ?? 0) - (a.done_ms ?? 0));
  return out;
}

/** Number of open tasks that need attention (late, waited on, due today). */
export function urgentCount(tasks: Task[], nowMs: number): number {
  return tasks.filter((t) => ['overdue', 'waiting', 'today'].includes(bucketOf(t, nowMs))).length;
}

export interface QuickTask {
  title: string;
  due: string | null;
  waiting_on: string | null;
}

/**
 * Quick-add syntax: free text, plus optionally
 *   `@Nom` (or `@"Nom composé"`) → who is waiting on it,
 *   a date: `aujourd'hui`, `demain`, `jj/mm`, `jj/mm/aaaa` or `aaaa-mm-jj`.
 * "Relancer EY @EY 07/11" → { title: "Relancer EY", waiting_on: "EY", due: "2026-11-07" }.
 */
export function parseQuickTask(text: string, nowMs: number): QuickTask {
  let rest = ` ${text} `;
  let waiting: string | null = null;
  let due: string | null = null;

  const who = rest.match(/\s@"([^"]+)"(?=\s)|\s@([^\s"]+)(?=\s)/);
  if (who) {
    waiting = (who[1] ?? who[2]).trim();
    rest = rest.replace(who[0], ' ');
  }

  const today = localDay(nowMs);
  const iso = rest.match(/\s(\d{4})-(\d{2})-(\d{2})(?=\s)/);
  const fr = rest.match(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?=\s)/);
  const word = rest.match(/\s(aujourd['’]hui|demain)(?=\s)/i);
  if (iso) {
    due = `${iso[1]}-${iso[2]}-${iso[3]}`;
    rest = rest.replace(iso[0], ' ');
  } else if (fr) {
    const day = Number(fr[1]);
    const month = Number(fr[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = fr[3] ? Number(fr[3].length === 2 ? `20${fr[3]}` : fr[3]) : Number(today.slice(0, 4));
      const p = (n: number): string => String(n).padStart(2, '0');
      let candidate = `${year}-${p(month)}-${p(day)}`;
      // "07/01" typed in December means next January.
      if (!fr[3] && candidate < addDays(today, -30)) {
        year += 1;
        candidate = `${year}-${p(month)}-${p(day)}`;
      }
      due = candidate;
      rest = rest.replace(fr[0], ' ');
    }
  } else if (word) {
    due = word[1].toLowerCase() === 'demain' ? addDays(today, 1) : today;
    rest = rest.replace(word[0], ' ');
  }

  return { title: rest.replace(/\s+/g, ' ').trim(), due, waiting_on: waiting };
}

/** Short French label for a due date: "aujourd'hui", "demain", "07/11". */
export function dueLabel(due: string, nowMs: number): string {
  const today = localDay(nowMs);
  if (due === today) return 'aujourd’hui';
  if (due === addDays(today, 1)) return 'demain';
  if (due === addDays(today, -1)) return 'hier';
  const [y, m, d] = due.split('-');
  return y === today.slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${y}`;
}
