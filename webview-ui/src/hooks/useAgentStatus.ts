// Tracks whether each claude agent is currently working (claude is using a
// tool) versus idle (no active tool_use). Subscribes to the same window
// `MessageEvent` stream that TamagotchiView already consumes — `useTerminals`
// re-dispatches every JSONL line through `dispatchWebviewMessage`, so this
// hook simply listens for the agentToolStart / agentToolDone / agentToolClear
// types and maintains a `Map<agentId, 'idle' | 'working'>`.
//
// Returns a stable `status(agentId)` function (memoized) so consumers can
// query the current state at render time without re-subscribing themselves.
//
// Each consumer (TamagotchiView, SessionsPane, OverviewPane, ProjectList)
// instantiates its own copy — the listener is cheap (a single `addEventListener`)
// and the duplicate state is bounded to (number of agents) entries.

import { useCallback, useEffect, useMemo, useState } from 'react';

export type AgentStatus = 'idle' | 'working' | 'absent';

export interface UseAgentStatusResult {
  /**
   * Current status for an agent.
   *  - 'working' → at least one open tool_use (Bash, Edit, Read…) on this agent
   *  - 'idle'    → known agent with no active tool_use
   *  - 'absent'  → agent id not seen by this hook yet (e.g. just spawned)
   */
  status: (agentId: number) => AgentStatus;
  /** True if any tracked agent is currently working. Cheap to read in renders. */
  anyWorking: boolean;
}

interface IncomingMessage {
  type?: string;
  agentId?: number;
  id?: number;
}

export function useAgentStatus(): UseAgentStatusResult {
  // Map of agentId → working flag. We only insert keys that we've heard
  // about, so `status()` can correctly distinguish 'absent' from 'idle'
  // for not-yet-seen agents.
  const [working, setWorking] = useState<Map<number, boolean>>(new Map());

  useEffect(() => {
    function handler(ev: MessageEvent): void {
      const data = ev.data as IncomingMessage | null;
      if (!data || typeof data !== 'object') return;
      const aid = data.agentId ?? data.id;
      if (typeof aid !== 'number') return;
      const t = data.type;
      if (t === 'agentToolStart') {
        setWorking((prev) => {
          if (prev.get(aid) === true) return prev;
          const next = new Map(prev);
          next.set(aid, true);
          console.debug('[Deepthix][useAgentStatus] working', { aid });
          return next;
        });
      } else if (t === 'agentToolDone' || t === 'agentToolClear') {
        setWorking((prev) => {
          if (prev.get(aid) === false) return prev;
          const next = new Map(prev);
          next.set(aid, false);
          console.debug('[Deepthix][useAgentStatus] idle', { aid });
          return next;
        });
      } else if (t === 'agentCreated') {
        // Mark as known-but-idle so consumers can render the green dot
        // immediately when a new session shows up.
        setWorking((prev) => {
          if (prev.has(aid)) return prev;
          const next = new Map(prev);
          next.set(aid, false);
          return next;
        });
      } else if (t === 'agentClosed') {
        setWorking((prev) => {
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

  const status = useCallback(
    (agentId: number): AgentStatus => {
      const w = working.get(agentId);
      if (w === undefined) return 'absent';
      return w ? 'working' : 'idle';
    },
    [working],
  );

  const anyWorking = useMemo(() => {
    for (const v of working.values()) {
      if (v) return true;
    }
    return false;
  }, [working]);

  return useMemo(() => ({ status, anyWorking }), [status, anyWorking]);
}
