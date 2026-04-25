import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  TERMINAL_DEFAULT_FONT_FAMILY,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_DEFAULT_LINE_HEIGHT,
} from '../constants';
import {
  killTerminal as cmdKillTerminal,
  loadSessions as cmdLoadSessions,
  type PersistedSession,
  saveSessions as cmdSaveSessions,
  spawnTerminal as cmdSpawnTerminal,
  type TerminalKind,
} from '../tauri/commands';
import { onAgentJsonlLine } from '../tauri/events';
import { parseRecord } from '../transcriptParser';

/**
 * Per-session terminal customization. Stored alongside the rest of the
 * `TerminalEntry` and persisted into `sessions.json` so reload restores
 * the user's font/zoom choices for every claude session independently.
 */
export interface TerminalSettings {
  /** Font size in CSS pixels. Clamped 8..32 by callers. */
  fontSize: number;
  /** CSS font-family list applied to the xterm canvas. */
  fontFamily: string;
  /** Line-height multiplier (1.0–1.6). 1.0 = xterm default. */
  lineHeight: number;
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontSize: TERMINAL_DEFAULT_FONT_SIZE,
  fontFamily: TERMINAL_DEFAULT_FONT_FAMILY,
  lineHeight: TERMINAL_DEFAULT_LINE_HEIGHT,
};

export interface TerminalEntry {
  id: string;
  label: string;
  cwd: string;
  kind: TerminalKind;
  agentId: number;
  sessionId: string | null;
  projectId: string;
  /** Spawned with --dangerously-skip-permissions; preserved on resume. */
  skipPermissions: boolean;
  /** Per-session font/line-height customization (Phase 10). */
  settings: TerminalSettings;
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
    opts?: {
      skipPermissions?: boolean;
      resumeSessionId?: string;
      settings?: Partial<TerminalSettings>;
    },
  ) => Promise<TerminalEntry | null>;
  close: (id: string) => Promise<void>;
  /** Returns terminals scoped to one project. */
  forProject: (projectId: string | null) => TerminalEntry[];
  /** Re-spawn every persisted claude session for the project (idempotent). */
  resumeProject: (projectId: string) => Promise<void>;
  /** Rename a session — updates label in memory + persisted store. */
  rename: (id: string, label: string) => void;
  /**
   * Patch a session's terminal settings. The TerminalTab observes the new
   * settings via props (re-renders + applies to xterm + re-fits the pty),
   * and the change is persisted to `sessions.json`.
   */
  updateSettings: (id: string, partial: Partial<TerminalSettings>) => void;
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

  /**
   * Persist the current claude sessions for `projectId` to disk so they can
   * be resumed across app restarts.
   */
  const persistProjectSessions = useCallback(
    (projectId: string): void => {
      const sessions: PersistedSession[] = terminalsRef.current
        .filter((t) => t.projectId === projectId && t.kind === 'claude' && t.sessionId)
        .map((t) => ({
          session_id: t.sessionId as string,
          label: t.label,
          cwd: t.cwd,
          skip_permissions: t.skipPermissions,
          created_at_ms: Date.now(),
          font_size: t.settings.fontSize,
          font_family: t.settings.fontFamily,
          line_height: t.settings.lineHeight,
        }));
      console.debug('[Deepthix][useTerminals] persistProjectSessions', {
        projectId,
        count: sessions.length,
      });
      void cmdSaveSessions(projectId, sessions).catch((err) => {
        console.error('[Deepthix][useTerminals] persistProjectSessions failed', err);
      });
    },
    [],
  );

  const open = useCallback(
    async (
      projectId: string,
      cwd: string,
      kind: TerminalKind = 'shell',
      label?: string,
      opts?: {
        skipPermissions?: boolean;
        resumeSessionId?: string;
        settings?: Partial<TerminalSettings>;
      },
    ): Promise<TerminalEntry | null> => {
      console.debug('[Deepthix][useTerminals] open', { projectId, cwd, kind, label, opts });
      try {
        const result = await cmdSpawnTerminal(cwd, kind, undefined, undefined, {
          skipPermissions: opts?.skipPermissions,
          resumeSessionId: opts?.resumeSessionId,
        });
        const agentId = nextAgentIdRef.current++;
        const settings: TerminalSettings = {
          ...DEFAULT_TERMINAL_SETTINGS,
          ...(opts?.settings ?? {}),
        };
        const entry: TerminalEntry = {
          id: result.id,
          label: label ?? `${kind === 'claude' ? 'session' : 'shell'}-${agentId}`,
          cwd,
          kind,
          agentId,
          sessionId: result.session_id,
          projectId,
          skipPermissions: opts?.skipPermissions ?? false,
          settings,
        };
        console.debug('[Deepthix][useTerminals] opened', entry);
        setTerminals((prev) => [...prev, entry]);
        terminalsRef.current = [...terminalsRef.current, entry];
        setActive(result.id);
        if (kind === 'claude') {
          dispatchWebviewMessage({
            type: 'agentCreated',
            id: agentId,
            terminalId: result.id,
            name: entry.label,
          });
          persistProjectSessions(projectId);
        }
        return entry;
      } catch (e) {
        console.error('[Deepthix][useTerminals] open failed', e);
        return null;
      }
    },
    [persistProjectSessions],
  );

  const resumeProject = useCallback(
    async (projectId: string): Promise<void> => {
      // Skip if we already have terminals for this project (avoids double-spawn
      // when an effect fires after the user has already opened sessions manually).
      const already = terminalsRef.current.some((t) => t.projectId === projectId);
      if (already) {
        console.debug('[Deepthix][useTerminals] resumeProject skipped (already loaded)', projectId);
        return;
      }
      let saved: PersistedSession[] = [];
      try {
        saved = await cmdLoadSessions(projectId);
      } catch (e) {
        console.error('[Deepthix][useTerminals] loadSessions failed', e);
        return;
      }
      console.debug('[Deepthix][useTerminals] resumeProject', { projectId, count: saved.length });
      for (const s of saved) {
        // claude resumes from the existing JSONL transcript when given the same
        // --session-id; if the JSONL is gone, claude starts a fresh session
        // under that id (still useful — keeps the same identifier).
        const settingsOverride: Partial<TerminalSettings> = {};
        if (typeof s.font_size === 'number') settingsOverride.fontSize = s.font_size;
        if (typeof s.font_family === 'string' && s.font_family.length > 0) {
          settingsOverride.fontFamily = s.font_family;
        }
        if (typeof s.line_height === 'number') settingsOverride.lineHeight = s.line_height;
        await open(projectId, s.cwd, 'claude', s.label, {
          skipPermissions: s.skip_permissions,
          resumeSessionId: s.session_id,
          settings: settingsOverride,
        });
      }
    },
    [open],
  );

  const close = useCallback(async (id: string): Promise<void> => {
    console.debug('[Deepthix][useTerminals] close', { id });
    const entry = terminalsRef.current.find((t) => t.id === id);
    try {
      await cmdKillTerminal(id);
    } catch (e) {
      console.error('[Deepthix][useTerminals] kill failed', e);
    }
    const projectId = entry?.projectId;
    setTerminals((prev) => prev.filter((t) => t.id !== id));
    terminalsRef.current = terminalsRef.current.filter((t) => t.id !== id);
    setActive((prev) => (prev === id ? null : prev));
    if (entry?.kind === 'claude') {
      dispatchWebviewMessage({ type: 'agentClosed', id: entry.agentId });
      if (projectId) persistProjectSessions(projectId);
    }
  }, [persistProjectSessions]);

  const forProject = useCallback(
    (projectId: string | null): TerminalEntry[] => {
      if (!projectId) return [];
      return terminals.filter((t) => t.projectId === projectId);
    },
    [terminals],
  );

  const rename = useCallback((id: string, label: string): void => {
    const trimmed = label.trim();
    if (!trimmed) return;
    let projectId: string | null = null;
    setTerminals((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        projectId = t.projectId;
        return { ...t, label: trimmed };
      }),
    );
    terminalsRef.current = terminalsRef.current.map((t) =>
      t.id === id ? { ...t, label: trimmed } : t,
    );
    if (projectId) persistProjectSessions(projectId);
    // Notify the office (TamagotchiView) that this character has a new name.
    const entry = terminalsRef.current.find((t) => t.id === id);
    if (entry?.kind === 'claude') {
      dispatchWebviewMessage({ type: 'agentRenamed', id: entry.agentId, name: trimmed });
    }
  }, [persistProjectSessions]);

  const updateSettings = useCallback(
    (id: string, partial: Partial<TerminalSettings>): void => {
      console.debug('[Deepthix][useTerminals] updateSettings', { id, partial });
      let projectId: string | null = null;
      let kind: TerminalKind | null = null;
      setTerminals((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          projectId = t.projectId;
          kind = t.kind;
          return { ...t, settings: { ...t.settings, ...partial } };
        }),
      );
      terminalsRef.current = terminalsRef.current.map((t) =>
        t.id === id ? { ...t, settings: { ...t.settings, ...partial } } : t,
      );
      // Only claude sessions are persisted (shells aren't saved to sessions.json).
      if (projectId && kind === 'claude') persistProjectSessions(projectId);
    },
    [persistProjectSessions],
  );

  return useMemo(
    () => ({
      terminals,
      activeId,
      setActive,
      open,
      close,
      forProject,
      resumeProject,
      rename,
      updateSettings,
    }),
    [terminals, activeId, open, close, forProject, resumeProject, rename, updateSettings],
  );
}
