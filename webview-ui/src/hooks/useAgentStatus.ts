// Tracks per-agent "working" status. An agent is considered "working" if
// EITHER it has at least one open tool_use (we still listen to
// agentToolStart/Done as a fast positive signal), OR it has produced any
// JSONL activity within the last `IDLE_TIMEOUT_MS`. The activity-window
// rule is the important one: claude's "Synthesizing/thinking with high
// effort" phases never emit tool events but DO write JSONL records every
// few seconds, so a pure-thinking session was previously stuck on the
// red dot even though it was clearly busy.
//
// `useTerminals` re-dispatches every JSONL line through
// `dispatchWebviewMessage` as `{ type: 'agentJsonlActivity', id }`, so
// this hook just listens and bumps a timestamp per agent.

import { useCallback, useEffect, useMemo, useState } from 'react';

export type AgentStatus = 'idle' | 'working' | 'absent';

export interface UseAgentStatusResult {
  status: (agentId: number) => AgentStatus;
  /** True if any tracked agent is currently working. Cheap to read in renders. */
  anyWorking: boolean;
}

interface IncomingMessage {
  type?: string;
  agentId?: number;
  id?: number;
}

interface AgentState {
  /** Open tool_use count. > 0 → unconditionally working. */
  openTools: number;
  /** Last JSONL activity timestamp (ms epoch). 0 if never seen. */
  lastActivityMs: number;
}

/** How long after the last JSONL line we still consider claude "working". */
const IDLE_TIMEOUT_MS = 5000;
/** How often to re-evaluate the idle timeout for the UI. */
const TICK_MS = 1000;

export function useAgentStatus(): UseAgentStatusResult {
  const [agents, setAgents] = useState<Map<number, AgentState>>(new Map());
  // `now` is bumped on a slow tick so the memoized status() recomputes
  // when an idle window expires — without this, an agent that goes
  // 5 seconds without activity would stay green until SOME other event
  // forced a re-render.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    function handler(ev: MessageEvent): void {
      const data = ev.data as IncomingMessage | null;
      if (!data || typeof data !== 'object') return;
      const aid = data.agentId ?? data.id;
      if (typeof aid !== 'number') return;
      const t = data.type;

      if (t === 'agentJsonlActivity') {
        setAgents((prev) => {
          const next = new Map(prev);
          const cur = next.get(aid) ?? { openTools: 0, lastActivityMs: 0 };
          next.set(aid, { ...cur, lastActivityMs: Date.now() });
          return next;
        });
        return;
      }

      if (t === 'agentToolStart') {
        setAgents((prev) => {
          const next = new Map(prev);
          const cur = next.get(aid) ?? { openTools: 0, lastActivityMs: 0 };
          next.set(aid, {
            openTools: cur.openTools + 1,
            lastActivityMs: Date.now(),
          });
          console.debug('[Deepthix][useAgentStatus] tool start', { aid, open: cur.openTools + 1 });
          return next;
        });
        return;
      }

      if (t === 'agentToolDone') {
        setAgents((prev) => {
          const next = new Map(prev);
          const cur = next.get(aid) ?? { openTools: 0, lastActivityMs: 0 };
          next.set(aid, {
            openTools: Math.max(0, cur.openTools - 1),
            lastActivityMs: Date.now(),
          });
          return next;
        });
        return;
      }

      if (t === 'agentToolClear') {
        // Hard reset of the tool count (used when a session is interrupted
        // mid-tool — we never get the matching Done so the count would
        // otherwise leak forever).
        setAgents((prev) => {
          const next = new Map(prev);
          const cur = next.get(aid) ?? { openTools: 0, lastActivityMs: 0 };
          next.set(aid, { ...cur, openTools: 0 });
          return next;
        });
        return;
      }

      if (t === 'agentCreated') {
        setAgents((prev) => {
          if (prev.has(aid)) return prev;
          const next = new Map(prev);
          // Seed with lastActivity = 0 so a brand-new session reads as
          // 'idle' (green dot waiting for input) instead of 'working'.
          next.set(aid, { openTools: 0, lastActivityMs: 0 });
          return next;
        });
        return;
      }

      if (t === 'agentClosed') {
        setAgents((prev) => {
          if (!prev.has(aid)) return prev;
          const next = new Map(prev);
          next.delete(aid);
          return next;
        });
      }
    }
    window.addEventListener('message', handler);
    console.debug('[Deepthix][useAgentStatus] subscribed');
    return () => {
      window.removeEventListener('message', handler);
      console.debug('[Deepthix][useAgentStatus] unsubscribed');
    };
  }, []);

  // Slow tick to expire idle windows. 1s granularity is plenty — the
  // dot doesn't need to flip the instant the 5s window closes.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const status = useCallback(
    (agentId: number): AgentStatus => {
      const a = agents.get(agentId);
      if (!a) return 'absent';
      if (a.openTools > 0) return 'working';
      if (a.lastActivityMs > 0 && now - a.lastActivityMs < IDLE_TIMEOUT_MS) {
        return 'working';
      }
      return 'idle';
    },
    [agents, now],
  );

  const anyWorking = useMemo(() => {
    for (const a of agents.values()) {
      if (a.openTools > 0) return true;
      if (a.lastActivityMs > 0 && now - a.lastActivityMs < IDLE_TIMEOUT_MS) {
        return true;
      }
    }
    return false;
  }, [agents, now]);

  return useMemo(() => ({ status, anyWorking }), [status, anyWorking]);
}
