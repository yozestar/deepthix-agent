import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  chatKill as cmdChatKill,
  chatSpawn as cmdChatSpawn,
  clearTerminalScrollback as cmdClearTerminalScrollback,
  type ClosedSession,
  jsonlMtimeMs as cmdJsonlMtimeMs,
  killTerminal as cmdKillTerminal,
  loadClosedSessions as cmdLoadClosedSessions,
  loadSessions as cmdLoadSessions,
  type PersistedSession,
  saveClosedSessions as cmdSaveClosedSessions,
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
  /** Set / update a terminal's session UUID once it becomes known.
   *  Used by the new chat flow: chat_spawn returns null at spawn time
   *  because claude only emits its session_id in the system/init event
   *  ~1s later. ChatPane calls this when init arrives so the entry is
   *  persisted with the right id (otherwise the session vanishes on
   *  next launch). */
  setSessionId: (id: string, sessionId: string) => void;
  /** Promote a lazy "ghost:" entry (registered at startup without
   *  spawning claude) to a real live terminal. Called by ChatPane when
   *  the user first sends a message in a ghost session — we swap the
   *  entry's id from ghost:<sid> to the real chat-<uuid> returned by
   *  chat_spawn so subsequent re-mounts don't re-spawn. */
  activateGhost: (ghostId: string, realTermId: string, sessionId: string | null) => void;
  /** Closed sessions of a project, newest first (reopenable). */
  closedForProject: (projectId: string | null) => ClosedSession[];
  /** Reopen a closed session as a lazy tab (same name, notes, history). */
  reopen: (projectId: string, sessionId: string) => void;
  /** Reopen the most recently closed session of the project, if any. */
  reopenLastClosed: (projectId: string) => void;
  /** Open an on-disk conversation that was never a tab here. */
  openTranscript: (projectId: string, cwd: string, sessionId: string, label: string) => void;
  /** Drop a closed session from the list (its conversation file stays). */
  forgetClosed: (projectId: string, sessionId: string) => void;
  /** Move a tab to `toIndex` within its project's tab order (persisted). */
  moveTab: (id: string, toIndex: number) => void;
}

function dispatchWebviewMessage(msg: { type: string; [k: string]: unknown }): void {
  console.debug('[Deepthix][useTerminals] dispatch', msg);
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

export function useTerminals(): UseTerminalsResult {
  const [terminals, setTerminals] = useState<TerminalEntry[]>([]);
  const [activeId, setActive] = useState<string | null>(null);

  const nextAgentIdRef = useRef(1);

  // Closed sessions per project (history panel). Mirrored in a ref so
  // callbacks read the latest list without re-subscribing.
  const [closed, setClosed] = useState<Record<string, ClosedSession[]>>({});
  const closedRef = useRef<Record<string, ClosedSession[]>>({});
  const updateClosed = useCallback(
    (projectId: string, fn: (list: ClosedSession[]) => ClosedSession[], persist = true): void => {
      const next = fn(closedRef.current[projectId] ?? []);
      closedRef.current = { ...closedRef.current, [projectId]: next };
      setClosed(closedRef.current);
      if (persist) {
        void cmdSaveClosedSessions(projectId, next).catch((e) => {
          console.error('[Elyone][useTerminals] saveClosedSessions failed', e);
        });
      }
    },
    [],
  );

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

    // (Removed: the ptyActivity bridge. Claude TUI redraws push bytes
    // through the pty even when claude is idle, which made the working
    // dot oscillate. Working status is now derived solely from JSONL
    // size growth — see the size-poll effect below.)

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
    };
  }, []);

  // Periodic JSONL-size poll. Every 2s, for every claude session, we
  // stat its JSONL file. If the SIZE grew since the last probe, claude
  // wrote new data → fire agentJsonlActivity → status dot turns green.
  // We deliberately ignore mtime-only changes: claude touches its JSONL
  // for heartbeats / metadata updates without writing real content, and
  // a pure mtime check produced false-positive working flashes when the
  // user wasn't doing anything.
  useEffect(() => {
    let cancelled = false;
    const lastSize = new Map<number, number>(); // agentId → last seen size_bytes
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const claudeTerms = terminalsRef.current.filter(
        (t) => t.kind === 'claude' && t.sessionId,
      );
      await Promise.all(
        claudeTerms.map(async (t) => {
          try {
            const stat = await cmdJsonlMtimeMs(t.cwd, t.sessionId as string);
            if (stat.size_bytes <= 0) return;
            const prev = lastSize.get(t.agentId);
            // First observation: record the size, don't fire — the file
            // may be days old at app start and the agent is clearly
            // idle right now.
            if (prev === undefined) {
              lastSize.set(t.agentId, stat.size_bytes);
              return;
            }
            if (stat.size_bytes > prev) {
              lastSize.set(t.agentId, stat.size_bytes);
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
      // Defensive dedup: if we're being asked to RESUME a session id we
      // already have a terminal for, skip — the prior call from a racing
      // resumeProject already spawned it. Without this, a transient
      // double-resume would spawn the same claude pty twice and the user
      // ends up with N "session-6" tabs for a single conversation.
      if (opts?.resumeSessionId) {
        const existing = terminalsRef.current.find(
          (t) => t.sessionId === opts.resumeSessionId,
        );
        if (existing) {
          console.debug('[Deepthix][useTerminals] open: already alive for sessionId', {
            sessionId: opts.resumeSessionId,
            existingId: existing.id,
          });
          return existing;
        }
      }
      try {
        // Claude sessions go through the new stream-json ChatManager
        // (no PTY, no Ink TUI). Shell sessions still spawn through
        // the PTY TerminalManager so they can host bash/zsh.
        let resultId: string;
        let resultSessionId: string | null;
        if (kind === 'claude') {
          const r = await cmdChatSpawn({
            cwd,
            resume_session_id: opts?.resumeSessionId ?? null,
            skip_permissions: opts?.skipPermissions ?? false,
          });
          resultId = r.term_id;
          // chat_spawn returns null at spawn time — the real session_id
          // is emitted later via the system/init event. But if WE
          // initiated a resume we already know the UUID; seed the entry
          // with it now so ChatPane can hydrate history immediately
          // instead of waiting for init (and so the scheduler /
          // sessionsPersist code paths see the right id from frame 1).
          resultSessionId = r.session_id ?? opts?.resumeSessionId ?? null;
        } else {
          const r = await cmdSpawnTerminal(cwd, kind, undefined, undefined, {
            skipPermissions: opts?.skipPermissions,
            resumeSessionId: opts?.resumeSessionId,
          });
          resultId = r.id;
          resultSessionId = r.session_id;
        }
        const agentId = nextAgentIdRef.current++;
        const entry: TerminalEntry = {
          id: resultId,
          label: label ?? `${kind === 'claude' ? 'session' : 'shell'}-${agentId}`,
          cwd,
          kind,
          agentId,
          sessionId: resultSessionId,
          projectId,
          skipPermissions: opts?.skipPermissions ?? false,
          notes: opts?.initialNotes ?? '',
        };
        console.debug('[Deepthix][useTerminals] opened', entry);
        setTerminals((prev) => [...prev, entry]);
        terminalsRef.current = [...terminalsRef.current, entry];
        setActive(resultId);
        if (kind === 'claude') {
          dispatchWebviewMessage({
            type: 'agentCreated',
            id: agentId,
            terminalId: resultId,
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

  /** Register a lazy "ghost:" tab for an existing conversation: history
   *  loads from the transcript, claude only spawns on the first send. */
  const registerGhost = useCallback(
    (
      projectId: string,
      s: { session_id: string; label: string; cwd: string; skip_permissions: boolean; notes?: string | null },
    ): string => {
      const ghostId = `ghost:${s.session_id}`;
      if (terminalsRef.current.some((t) => t.id === ghostId)) return ghostId;
      const agentId = nextAgentIdRef.current++;
      const entry: TerminalEntry = {
        id: ghostId,
        label: s.label,
        cwd: s.cwd,
        kind: 'claude',
        agentId,
        sessionId: s.session_id,
        projectId,
        skipPermissions: s.skip_permissions,
        notes: s.notes ?? '',
      };
      setTerminals((prev) => [...prev, entry]);
      terminalsRef.current = [...terminalsRef.current, entry];
      dispatchWebviewMessage({ type: 'agentCreated', id: agentId, terminalId: ghostId, name: entry.label });
      return ghostId;
    },
    [],
  );

  const resumeProject = useCallback(
    async (projectId: string): Promise<void> => {
      // Closed-session list (history panel) — independent of open tabs.
      if (!(projectId in closedRef.current)) {
        void cmdLoadClosedSessions(projectId)
          .then((list) => updateClosed(projectId, () => list, false))
          .catch((e) => console.error('[Elyone][useTerminals] loadClosedSessions failed', e));
      }
      // Skip if we already have terminals for this project (avoids double-load
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
      // LAZY: don't spawn claude at all on startup. Register a "ghost"
      // TerminalEntry per saved session — the chat tab + history are
      // both available without burning RAM on a claude process the user
      // may never touch this session. claude only spawns when the user
      // actually sends a message (ChatPane sees the ghost: prefix,
      // flips sessionExitedRef so send() takes the auto-respawn path,
      // and the first send triggers a real chat_spawn).
      for (const s of saved) registerGhost(projectId, s);
    },
    [registerGhost, updateClosed],
  );

  const close = useCallback(async (id: string): Promise<void> => {
    console.debug('[Deepthix][useTerminals] close', { id });
    const entry = terminalsRef.current.find((t) => t.id === id);
    try {
      // Claude sessions live in ChatManager; shells in TerminalManager.
      // Pick the right kill API.
      if (entry?.kind === 'claude') {
        await cmdChatKill(id);
      } else {
        await cmdKillTerminal(id);
      }
    } catch (e) {
      console.error('[Deepthix][useTerminals] kill failed', e);
    }
    const projectId = entry?.projectId;
    // Remember the session so it can be reopened from the history panel.
    // Its conversation file is never deleted.
    if (entry?.kind === 'claude' && entry.sessionId && projectId) {
      const item: ClosedSession = {
        session_id: entry.sessionId,
        label: entry.label.trim() || `Session ${entry.sessionId.slice(0, 8)}`,
        cwd: entry.cwd,
        skip_permissions: entry.skipPermissions,
        notes: entry.notes || null,
        closed_at_ms: Date.now(),
      };
      updateClosed(projectId, (list) => [item, ...list.filter((c) => c.session_id !== item.session_id)]);
    }
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
  }, [persistProjectSessions, updateClosed]);

  const closedForProject = useCallback(
    (projectId: string | null): ClosedSession[] => (projectId ? (closed[projectId] ?? []) : []),
    [closed],
  );

  /** Focus an already-open tab for this conversation, if any. */
  const focusExisting = useCallback((sessionId: string): boolean => {
    const open = terminalsRef.current.find((t) => t.sessionId === sessionId);
    if (open) setActive(open.id);
    return !!open;
  }, []);

  const reopen = useCallback(
    (projectId: string, sessionId: string): void => {
      const item = (closedRef.current[projectId] ?? []).find((c) => c.session_id === sessionId);
      if (!item) return;
      if (!focusExisting(sessionId)) {
        const ghostId = registerGhost(projectId, item);
        persistProjectSessions(projectId);
        setActive(ghostId);
      }
      updateClosed(projectId, (list) => list.filter((c) => c.session_id !== sessionId));
    },
    [focusExisting, registerGhost, persistProjectSessions, updateClosed],
  );

  const reopenLastClosed = useCallback(
    (projectId: string): void => {
      const last = (closedRef.current[projectId] ?? [])[0];
      if (last) reopen(projectId, last.session_id);
    },
    [reopen],
  );

  const openTranscript = useCallback(
    (projectId: string, cwd: string, sessionId: string, label: string): void => {
      if (focusExisting(sessionId)) return;
      const ghostId = registerGhost(projectId, {
        session_id: sessionId,
        label,
        cwd,
        skip_permissions: false,
      });
      persistProjectSessions(projectId);
      setActive(ghostId);
    },
    [focusExisting, registerGhost, persistProjectSessions],
  );

  const moveTab = useCallback(
    (id: string, toIndex: number): void => {
      const all = terminalsRef.current;
      const entry = all.find((t) => t.id === id);
      if (!entry) return;
      const siblings = all.filter((t) => t.projectId === entry.projectId);
      const from = siblings.findIndex((t) => t.id === id);
      const target = Math.max(0, Math.min(siblings.length - 1, toIndex));
      if (from === target) return;
      const reordered = [...siblings];
      reordered.splice(from, 1);
      reordered.splice(target, 0, entry);
      // Put the project's tabs back into the global array at the slots
      // they already occupy, so other projects' order is untouched.
      let k = 0;
      const next = all.map((t) => (t.projectId === entry.projectId ? reordered[k++] : t));
      terminalsRef.current = next;
      setTerminals(next);
      // sessions.json is written in array order → the order survives a restart.
      persistProjectSessions(entry.projectId);
    },
    [persistProjectSessions],
  );

  const forgetClosed = useCallback(
    (projectId: string, sessionId: string): void => {
      updateClosed(projectId, (list) => list.filter((c) => c.session_id !== sessionId));
    },
    [updateClosed],
  );

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

  /** See UseTerminalsResult.activateGhost. */
  const activateGhost = useCallback(
    (ghostId: string, realTermId: string, sessionId: string | null): void => {
      let projectId: string | null = null;
      setTerminals((prev) =>
        prev.map((t) => {
          if (t.id !== ghostId) return t;
          projectId = t.projectId;
          return {
            ...t,
            id: realTermId,
            sessionId: sessionId ?? t.sessionId,
          };
        }),
      );
      terminalsRef.current = terminalsRef.current.map((t) =>
        t.id === ghostId
          ? { ...t, id: realTermId, sessionId: sessionId ?? t.sessionId }
          : t,
      );
      setActive((prev) => (prev === ghostId ? realTermId : prev));
      if (projectId) persistProjectSessions(projectId);
    },
    [persistProjectSessions],
  );

  /** Set / update a terminal's session UUID. Idempotent — no-op if the
   *  current sessionId already matches. Triggers a persist so the
   *  session survives the next launch. */
  const setSessionId = useCallback(
    (id: string, sessionId: string): void => {
      let projectId: string | null = null;
      let needsPersist = false;
      setTerminals((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          if (t.sessionId === sessionId) return t;
          projectId = t.projectId;
          needsPersist = true;
          return { ...t, sessionId };
        }),
      );
      terminalsRef.current = terminalsRef.current.map((t) =>
        t.id === id && t.sessionId !== sessionId ? { ...t, sessionId } : t,
      );
      if (needsPersist && projectId) persistProjectSessions(projectId);
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
      setSessionId,
      activateGhost,
      closedForProject,
      reopen,
      reopenLastClosed,
      openTranscript,
      forgetClosed,
      moveTab,
    }),
    [
      terminals,
      activeId,
      open,
      close,
      forProject,
      resumeProject,
      rename,
      updateNotes,
      setSessionId,
      activateGhost,
      closedForProject,
      reopen,
      reopenLastClosed,
      openTranscript,
      forgetClosed,
      moveTab,
    ],
  );
}
