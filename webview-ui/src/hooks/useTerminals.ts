import { useCallback, useEffect, useRef, useState } from 'react';

import {
  killTerminal as cmdKillTerminal,
  spawnTerminal as cmdSpawnTerminal,
  type TerminalKind,
} from '../tauri/commands';
import { onAgentJsonlLine } from '../tauri/events';
import { parseRecord } from '../transcriptParser';

export interface TerminalEntry {
  id: string;
  label: string;
  cwd: string;
  kind: TerminalKind;
  agentId: number;
  sessionId: string | null;
}

export interface UseTerminalsResult {
  terminals: TerminalEntry[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  open: (cwd: string, kind?: TerminalKind, label?: string) => Promise<TerminalEntry | null>;
  close: (id: string) => Promise<void>;
}

/**
 * Convert a parser-emitted message into the legacy pixel-agents window
 * MessageEvent shape consumed by `useExtensionMessages`. Logged at debug for
 * easier troubleshooting when the office character doesn't react.
 */
function dispatchWebviewMessage(msg: { type: string; [k: string]: unknown }): void {
  console.debug('[Deepthix][useTerminals] dispatch', msg);
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

export function useTerminals(): UseTerminalsResult {
  const [terminals, setTerminals] = useState<TerminalEntry[]>([]);
  const [activeId, setActive] = useState<string | null>(null);

  // Monotonic agent id (1-based) used by the office canvas as the character key.
  const nextAgentIdRef = useRef(1);

  // Mirror of `terminals` so the JSONL listener can resolve term-id → agent-id
  // without re-subscribing every time the list changes.
  const terminalsRef = useRef<TerminalEntry[]>([]);
  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);

  // Subscribe once to the global agent_jsonl_line event stream. Each line is
  // parsed and dispatched as window message events for officeState.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const lookupAgentId = (termId: string): number | undefined => {
      const entry = terminalsRef.current.find((t) => t.id === termId);
      return entry?.agentId;
    };

    void onAgentJsonlLine((e) => {
      const agentId = lookupAgentId(e.id);
      if (agentId === undefined) {
        console.debug('[Deepthix][useTerminals] jsonl line for unknown terminal', e.id);
        return;
      }
      const messages = parseRecord(agentId, e.line);
      for (const msg of messages) dispatchWebviewMessage(msg);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
        console.debug('[Deepthix][useTerminals] subscribed to agent_jsonl_line');
      })
      .catch((err) => {
        console.error('[Deepthix][useTerminals] subscribe failed', err);
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const open = useCallback(
    async (
      cwd: string,
      kind: TerminalKind = 'shell',
      label?: string,
    ): Promise<TerminalEntry | null> => {
      console.debug('[Deepthix][useTerminals] open', { cwd, kind, label });
      try {
        const result = await cmdSpawnTerminal(cwd, kind);
        const agentId = nextAgentIdRef.current++;
        const entry: TerminalEntry = {
          id: result.id,
          label: label ?? `${kind === 'claude' ? 'agent' : 'shell'}-${agentId}`,
          cwd,
          kind,
          agentId,
          sessionId: result.session_id,
        };
        console.debug('[Deepthix][useTerminals] opened', entry);
        setTerminals((prev) => [...prev, entry]);
        setActive(result.id);
        // Tell the office to spawn a character for this agent (heuristic mode).
        if (kind === 'claude') {
          dispatchWebviewMessage({
            type: 'agentCreated',
            id: agentId,
            terminalId: result.id,
            name: entry.label,
          });
        }
        return entry;
      } catch (e) {
        console.error('[Deepthix][useTerminals] open failed', e);
        return null;
      }
    },
    [],
  );

  const close = useCallback(async (id: string): Promise<void> => {
    console.debug('[Deepthix][useTerminals] close', { id });
    const entry = terminalsRef.current.find((t) => t.id === id);
    try {
      await cmdKillTerminal(id);
    } catch (e) {
      console.error('[Deepthix][useTerminals] kill failed', e);
    }
    setTerminals((prev) => prev.filter((t) => t.id !== id));
    setActive((prev) => (prev === id ? null : prev));
    if (entry?.kind === 'claude') {
      dispatchWebviewMessage({ type: 'agentClosed', id: entry.agentId });
    }
  }, []);

  return { terminals, activeId, setActive, open, close };
}
