import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bucketOf, classifyTasks, dueLabel, parseQuickTask, urgentCount } from '../src/tasks.ts';
import type { Task } from '../src/tauri/commands.ts';

const DAY = 86_400_000;
// Tuesday 2026-11-03, 10:00 local time.
const NOW = new Date(2026, 10, 3, 10).getTime();

const task = (over: Partial<Task> = {}): Task => ({
  id: 'x',
  project_id: 'p',
  title: 't',
  notes: '',
  status: 'todo',
  due: null,
  waiting_on: null,
  session_label: '',
  session_id: null,
  source: 'user',
  created_ms: NOW - DAY,
  updated_ms: NOW - DAY,
  done_ms: null,
  ...over,
});

test('buckets: late, waiting, today, week, later', () => {
  assert.equal(bucketOf(task({ due: '2026-11-02' }), NOW), 'overdue');
  assert.equal(bucketOf(task({ waiting_on: 'EY' }), NOW), 'waiting');
  assert.equal(bucketOf(task({ due: '2026-11-03' }), NOW), 'today');
  assert.equal(bucketOf(task({ due: '2026-11-10' }), NOW), 'week');
  assert.equal(bucketOf(task({ due: '2026-11-11' }), NOW), 'later');
  assert.equal(bucketOf(task(), NOW), 'later');
});

test('late wins over a waiting client; done wins over everything', () => {
  assert.equal(bucketOf(task({ due: '2026-10-01', waiting_on: 'EY' }), NOW), 'overdue');
  assert.equal(bucketOf(task({ status: 'done', due: '2026-10-01' }), NOW), 'done');
});

test('a task untouched for 14 days is stale, unless dated today or waited on', () => {
  const old = NOW - 14 * DAY;
  assert.equal(bucketOf(task({ updated_ms: old }), NOW), 'stale');
  assert.equal(bucketOf(task({ updated_ms: NOW - 13 * DAY }), NOW), 'later');
  assert.equal(bucketOf(task({ updated_ms: old, waiting_on: 'EY' }), NOW), 'waiting');
  assert.equal(bucketOf(task({ updated_ms: old, due: '2026-11-03' }), NOW), 'today');
});

test('classify sorts by due date then age, and counts the urgent ones', () => {
  const a = task({ id: 'a', due: '2026-11-09' });
  const b = task({ id: 'b', due: '2026-11-05' });
  const c = task({ id: 'c', waiting_on: 'Go formations' });
  const g = classifyTasks([a, b, c], NOW);
  assert.deepEqual(g.week.map((t) => t.id), ['b', 'a']);
  assert.deepEqual(g.waiting.map((t) => t.id), ['c']);
  assert.equal(urgentCount([a, b, c, task({ due: '2026-11-01' })], NOW), 2);
});

test('quick add: who, date and title', () => {
  assert.deepEqual(parseQuickTask('Relancer EY @EY 07/11', NOW), {
    title: 'Relancer EY',
    waiting_on: 'EY',
    due: '2026-11-07',
  });
  assert.deepEqual(parseQuickTask('Devis @"Go formations" demain', NOW), {
    title: 'Devis',
    waiting_on: 'Go formations',
    due: '2026-11-04',
  });
  assert.deepEqual(parseQuickTask('  Idée de pricing  ', NOW), {
    title: 'Idée de pricing',
    waiting_on: null,
    due: null,
  });
  assert.equal(parseQuickTask('x 2026-12-01', NOW).due, '2026-12-01');
  assert.equal(parseQuickTask('x 5/1', NOW).due, '2027-01-05', 'past month → next year');
  assert.equal(parseQuickTask('x 31/13', NOW).due, null, 'not a date');
  assert.equal(parseQuickTask('mail jean@acme.fr', NOW).waiting_on, null, 'an email is not @who');
});

test('due labels', () => {
  assert.equal(dueLabel('2026-11-03', NOW), 'aujourd’hui');
  assert.equal(dueLabel('2026-11-04', NOW), 'demain');
  assert.equal(dueLabel('2026-11-20', NOW), '20/11');
  assert.equal(dueLabel('2027-01-05', NOW), '05/01/2027');
});
