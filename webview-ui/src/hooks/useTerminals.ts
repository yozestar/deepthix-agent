import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  projectId: string;
}

export interface UseTerminalsResult {
  /** All terminals across every project (flat, unfiltered). */
  terminals: TerminalEntry[];
  /** Active tab id (filtered to the visible project's terminals at the call site). */
  activeId: string | null;
  setActive: (id: string | null) => void;
  open: (
    projectId: string,
    cwd: string,
    kind?: TerminalKind,
    label?: string,
    opts?: { skipPermissions?: boolean },
  ) => Promise<TerminalEntry | null>;
  close: (id: string) => Promise<void>;
  /**
   * Returns terminals scoped to one project. Used by the BottomPanel and the
   * project-switch effect to drive office character add/remove.
   */
  forProject: (projectId: string | null) => TerminalEntry[];
}

function dispatchWebviewMessage(msg: { type: string; [k: string]: unknown }): void {
  console.debug('[Deepthix][useTerminals] dispatch', msg);
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

export function useTerminals(): UseTerminalsResult {
  const [terminals, setTerminals] = useState<TerminalEntry[]>([]);
  const [activeId, setActive] = useState<string | null>(null);

  const nextAgentIdRef = useRef(1);

  const terminalsRef = useRef<TerminalEntry[]>([]);
  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);

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
      projectId: string,
      cwd: string,
      kind: TerminalKind = 'shell',
      label?: string,
      opts?: { skipPermissions?: boolean },
    ): Promise<TerminalEntry | null> => {
      console.debug('[Deepthix][useTerminals] open', { projectId, cwd, kind, label, opts });
      try {
        const result = await cmdSpawnTerminal(cwd, kind, undefined, undefined, opts);
        const agentId = nextAgentIdRef.current++;
        const entry: TerminalEntry = {
          id: result.id,
          label: label ?? `${kind === 'claude' ? 'session' : 'shell'}-${agentId}`,
          cwd,
          kind,
          agentId,
          sessionId: result.session_id,
          projectId,
        };
        console.debug('[Deepthix][useTerminals] opened', entry);
        setTerminals((prev) => [...prev, entry]);
        setActive(result.id);
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

  const forProject = useCallback(
    (projectId: string | null): TerminalEntry[] => {
      if (!projectId) return [];
      return terminals.filter((t) => t.projectId === projectId);
    },
    [terminals],
  );

  return useMemo(
    () => ({ terminals, activeId, setActive, open, close, forProject }),
    [terminals, activeId, open, close, forProject],
  );
}
