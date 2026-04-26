import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  clearTerminalScrollback as cmdClearTerminalScrollback,
  jsonlMtimeMs as cmdJsonlMtimeMs,
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
 * One claude/shell terminal. Per-session font/zoom settings used to live
 * here (Phase 10) but were promoted to a single global config in Phase 11
 * so all sessions share the same look. The legacy `font_size`/`font_family`/
 * `line_height` keys still exist in older `sessions.json` files; they're
 * tolerated by the Rust struct via `#[serde(default)]` and quietly ignored
 * on read here (we don't carry them forward into TerminalEntry).
 */
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
  /** Free-form per-session notes shown in the OVERVIEW tab. Defaults to ''. */
  notes: string;
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
      /** Restored OVERVIEW notes — used by `resumeProject` to seed the entry without round-tripping through persist. */
      initialNotes?: string;
    },
  ) => Promise<TerminalEntry | null>;
  close: (id: string) => Promise<void>;
  /** Returns terminals scoped to one project. */
  forProject: (projectId: string | null) => TerminalEntry[];
  /** Re-spawn every persisted claude session for the project (idempotent). */
  resumeProject: (projectId: string) => Promise<void>;
  /** Rename a session — updates label in memory + persisted store. */
  rename: (id: string, label: string) => void;
  /** Update the per-session OVERVIEW notes — debounced-persisted at the call site. */
  updateNotes: (id: string, notes: string) => void;
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

    // ptyActivity → translate termId to agentId then re-dispatch as
    // agentJsonlActivity (the same activity-ping channel useAgentStatus
    // already listens for). Pty stdout fires within a frame of every
    // chunk claude streams — much faster than the 500ms JSONL polling
    // window — so the dot turns green before the user can blink.
    function onPtyActivityMessage(ev: MessageEvent): void {
      const data = ev.data as { type?: string; termId?: string } | null;
      if (!data || data.type !== 'ptyActivity' || typeof data.termId !== 'string') return;
      const agentId = lookupAgentId(data.termId);
      if (agentId === undefined) return;
      dispatchWebviewMessage({ type: 'agentJsonlActivity', id: agentId });
    }
    window.addEventListener('message', onPtyActivityMessage);

    void onAgentJsonlLine((e) => {
      const agentId = lookupAgentId(e.id);
      if (agentId === undefined) {
        console.debug('[Deepthix][useTerminals] jsonl line for unknown terminal', e.id);
        return;
      }
      // Raw activity ping — ANY JSONL line means claude is alive and
      // doing something (thinking, streaming, tool I/O…). useAgentStatus
      // listens for this and times-out to idle if nothing arrives for a
      // few seconds. This catches "Synthesizing/thinking with high
      // effort" phases that produce no tool_use events.
      dispatchWebviewMessage({ type: 'agentJsonlActivity', id: agentId });
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
      window.removeEventListener('message', onPtyActivityMessage);
    };
  }, []);

  // Periodic JSONL-mtime poll. The pty/event chain is the FAST path
  // (sub-frame latency on activity) but it's fragile — it depends on
  // TerminalTab being mounted, ptyActivity being dispatched before the
  // terminals ref settles, etc. The mtime poll is the SLOW reliable
  // path: every 2s, for every claude session, we stat its JSONL file
  // and dispatch agentJsonlActivity if mtime moved since the last
  // probe. This guarantees the working dot turns green within ~2s of
  // any actual activity, even when the event chain breaks.
  useEffect(() => {
    let cancelled = false;
    const lastMtime = new Map<number, number>(); // agentId → last seen mtime
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const claudeTerms = terminalsRef.current.filter(
        (t) => t.kind === 'claude' && t.sessionId,
      );
      await Promise.all(
        claudeTerms.map(async (t) => {
          try {
            const mtime = await cmdJsonlMtimeMs(t.cwd, t.sessionId as string);
            if (mtime <= 0) return;
            const prev = lastMtime.get(t.agentId);
            // First observation: just record the mtime, don't fire the
            // working signal — the file may be days old at app start
            // and the agent is clearly idle right now.
            if (prev === undefined) {
              lastMtime.set(t.agentId, mtime);
              return;
            }
            if (mtime > prev) {
              lastMtime.set(t.agentId, mtime);
              dispatchWebviewMessage({ type: 'agentJsonlActivity', id: t.agentId });
            }
          } catch {
            // ignore per-session failures (file may not exist yet)
          }
        }),
      );
    };
    void tick();
    const id = setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  /**
   * Persist the current claude sessions for `projectId` to disk so they can
   * be resumed across app restarts. Per-session font fields are intentionally
   * left null — the legacy struct still accepts them but the global config
   * (`~/.deepthix/config.json`) is the live source of truth from Phase 11 on.
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
          notes: t.notes || null,
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
        initialNotes?: string;
      },
    ): Promise<TerminalEntry | null> => {
      console.debug('[Deepthix][useTerminals] open', { projectId, cwd, kind, label, opts });
      try {
        const result = await cmdSpawnTerminal(cwd, kind, undefined, undefined, {
          skipPermissions: opts?.skipPermissions,
          resumeSessionId: opts?.resumeSessionId,
        });
        const agentId = nextAgentIdRef.current++;
        const entry: TerminalEntry = {
          id: result.id,
          label: label ?? `${kind === 'claude' ? 'session' : 'shell'}-${agentId}`,
          cwd,
          kind,
          agentId,
          sessionId: result.session_id,
          projectId,
          skipPermissions: opts?.skipPermissions ?? false,
          notes: opts?.initialNotes ?? '',
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
        await open(projectId, s.cwd, 'claude', s.label, {
          skipPermissions: s.skip_permissions,
          resumeSessionId: s.session_id,
          initialNotes: s.notes ?? '',
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
      // The conversation is gone (claude pty was killed) → drop the saved
      // scrollback so it doesn't leak disk after the user reopens the app.
      // Best-effort: a failure here is fine, the file just stays orphaned.
      if (projectId && entry.sessionId) {
        void cmdClearTerminalScrollback(projectId, entry.sessionId).catch((e) => {
          console.warn('[Deepthix][useTerminals] clear scrollback failed', e);
        });
      }
    }
  }, [persistProjectSessions]);

  const forProject = useCallback(
    (projectId: string | null): TerminalEntry[] => {
      if (!projectId) return [];
      return terminals.filter((t) => t.projectId === projectId);
    },
    [terminals],
  );

  // Per-session OVERVIEW notes. The OverviewPane debounces calls so we get
  // one persist per ~500ms-quiet-window, not one per keystroke. We still
  // update local state synchronously so the textarea stays responsive.
  const updateNotes = useCallback(
    (id: string, notes: string): void => {
      let projectId: string | null = null;
      setTerminals((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          projectId = t.projectId;
          return { ...t, notes };
        }),
      );
      terminalsRef.current = terminalsRef.current.map((t) =>
        t.id === id ? { ...t, notes } : t,
      );
      if (projectId) persistProjectSessions(projectId);
    },
    [persistProjectSessions],
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
      updateNotes,
    }),
    [terminals, activeId, open, close, forProject, resumeProject, rename, updateNotes],
  );
}
