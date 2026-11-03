// One shared copy of tasks.json for every screen that shows tasks (Tâches
// tab, project Overview, tab counters, the conversation's "Reste à faire").
// A single poll runs while at least one of them is mounted, so many open
// tabs cost one read, not one each (it matters on a remote device).

import { useEffect, useState } from 'react';

import { TASKS_POLL_MS } from '../constants';
import { startPolling } from '../remote/polling';
import { type Task, tasksList } from '../tauri/commands';

let tasks: Task[] = [];
let loaded = false;
let error: string | null = null;
const listeners = new Set<() => void>();
let stopPoll: (() => void) | null = null;
let inFlight: Promise<void> | null = null;

function emit(): void {
  for (const l of listeners) l();
}

/** Re-read tasks.json now (call after any change). */
export function refreshTasks(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = tasksList(null)
    .then((list) => {
      tasks = list;
      error = null;
    })
    .catch((e: unknown) => {
      error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      loaded = true;
      inFlight = null;
      emit();
    });
  return inFlight;
}

export interface TasksState {
  tasks: Task[];
  loaded: boolean;
  error: string | null;
}

export function useTasks(): TasksState {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = (): void => setTick((n) => n + 1);
    listeners.add(l);
    if (listeners.size === 1) {
      void refreshTasks();
      stopPoll = startPolling(() => void refreshTasks(), TASKS_POLL_MS);
    }
    return () => {
      listeners.delete(l);
      if (listeners.size === 0 && stopPoll) {
        stopPoll();
        stopPoll = null;
      }
    };
  }, []);
  return { tasks, loaded, error };
}

/** Open tasks of one conversation. */
export function openTasksOf(all: Task[], sessionId: string | null | undefined): Task[] {
  if (!sessionId) return [];
  return all.filter((t) => t.status !== 'done' && t.session_id === sessionId);
}
