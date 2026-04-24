import { useCallback, useState } from 'react';

import { killTerminal as cmdKillTerminal, spawnTerminal as cmdSpawnTerminal } from '../tauri/commands';

export interface TerminalEntry {
  id: string;
  label: string;
  cwd: string;
}

export interface UseTerminalsResult {
  terminals: TerminalEntry[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  open: (cwd: string, label?: string) => Promise<TerminalEntry | null>;
  close: (id: string) => Promise<void>;
}

export function useTerminals(): UseTerminalsResult {
  const [terminals, setTerminals] = useState<TerminalEntry[]>([]);
  const [activeId, setActive] = useState<string | null>(null);

  const open = useCallback(
    async (cwd: string, label?: string): Promise<TerminalEntry | null> => {
      console.debug('[Deepthix][useTerminals] open', { cwd, label });
      try {
        const { id } = await cmdSpawnTerminal(cwd);
        const entry: TerminalEntry = {
          id,
          label: label ?? `term-${terminals.length + 1}`,
          cwd,
        };
        console.debug('[Deepthix][useTerminals] opened', entry);
        setTerminals((prev) => [...prev, entry]);
        setActive(id);
        return entry;
      } catch (e) {
        console.error('[Deepthix][useTerminals] open failed', e);
        return null;
      }
    },
    [terminals.length],
  );

  const close = useCallback(async (id: string): Promise<void> => {
    console.debug('[Deepthix][useTerminals] close', { id });
    try {
      await cmdKillTerminal(id);
    } catch (e) {
      console.error('[Deepthix][useTerminals] kill failed', e);
    }
    setTerminals((prev) => prev.filter((t) => t.id !== id));
    setActive((prev) => (prev === id ? null : prev));
  }, []);

  return { terminals, activeId, setActive, open, close };
}
