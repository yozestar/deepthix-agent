/* eslint-disable deepthix/no-inline-colors, deepthix/pixel-font */
// Project-level Coach.
//
// Single ON/OFF toggle per project. When ON, every COACH_INTERVAL_MS
// the coach reads recent activity from EVERY claude session in the
// project, concatenates excerpts, and asks a Sonnet sub-session to
// suggest improvements. The user can append any suggestion to
// CLAUDE.md with one click so the main sessions inherit it.
//
// State persisted in `~/.deepthix/projects/<pid>/coach.json` (Rust):
// `{ enabled, coach_session_id, last_run_ms }`. Coach session lives
// in the same project cwd; survives app restarts via --resume.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  appendToClaudeMd,
  type Cadence,
  chatInterrupt,
  chatKill,
  chatSendUserText,
  chatSetSessionId,
  chatSpawn,
  type CoachState,
  coachWorkspacePath,
  createSchedule,
  createWorkflow,
  readGlobalCoachMessages,
  readGlobalCoachState,
  readSessionExcerpt,
  writeGlobalCoachMessages,
  writeGlobalCoachState,
} from '../tauri/commands';
import { onChatEvent, onChatExit } from '../tauri/events';

const COACH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const EXCERPT_TURNS_PER_SESSION = 10;
const COACH_PROMPT_PREFIX = `You are a coaching agent watching multiple claude sessions in a project. Your job is two-fold:

(A) PROPOSALS — emit cards the user can Accept/Reject in the UI. Three kinds:

1. <proposal> — a rule worth remembering for future sessions. Write the memory text as a directive ("When editing X, always Y because Z.").

<proposal>
<title>One short sentence — what to change</title>
<why>One sentence — productivity / cost / correctness / clarity / performance</why>
<memory>Exact text appended to CLAUDE.md when accepted. Skip the block if it isn't memory-worthy.</memory>
</proposal>

2. <schedule> — a recurring or one-shot job. Accepting creates a Deepthix schedule against the first claude session in the project; the prompt you write is what the schedule will fire each tick.

<schedule>
<title>Short name — what the schedule does</title>
<why>One sentence — why this should run on a cadence</why>
<prompt>Exact prompt the scheduled run will send to claude. Self-contained — the session must be able to act on it with no extra context.</prompt>
<every_minutes>Integer minutes between runs. 60=hourly, 1440=daily, 10080=weekly. Omit for one-shot (then include <at_iso> with an ISO-8601 datetime).</every_minutes>
</schedule>

3. <workflow> — a saved prompt recipe the user (or you) can re-fire on demand from the WORKFLOW tab. Use this for sequences the user keeps re-typing manually (deploy steps, sweep scripts, weekly reports, anything reusable). The user accepts → we add it to the catalog at $DEEPTHIX_WORKFLOWS_PATH and they can run it any time.

<workflow>
<title>Short workflow name (becomes the entry's name)</title>
<why>One sentence — what pattern in the user's activity made this worth saving</why>
<description>One-liner shown in the WORKFLOW list (optional)</description>
<prompt>Exact prompt the workflow will ship to claude on Run. Self-contained, parameterised in plain English ("the latest deploy", "this week's data") since v1 has no variables.</prompt>
<tags>Comma-separated tags (optional, e.g. "deploy,prod"). Skip if none.</tags>
</workflow>

(B) DIRECT ACTIONS — you also have access to your tools (Write, Read, Bash, Grep, etc.). Use them WITHOUT asking when:
- You see a project-wide insight worth pinning to the dashboard. The path is in the env var $DEEPTHIX_DASHBOARD_PATH (a single dashboard.html for the project, rendered in the OVERVIEW tab). Use Write with semantic, scannable HTML — keep it under ~15KB, no external assets. Last writer wins; rewrite the whole file so partial updates can't corrupt earlier sections.

Watch for performance signals (high token usage, slow turns, repeated dead-ends, inefficient tool sequences) alongside the usual productivity / correctness / cost signals.

Output rules: only <proposal>/<schedule> blocks for the cards (no preamble or postamble); tool calls happen as normal. Aim for 1–5 cards total — skip the small stuff.

Recent activity follows.

---

`;

interface SessionRef {
  /** Stable claude session UUID (claude --resume target). */
  sessionId: string;
  /** Friendly label shown in the excerpt header. */
  label: string;
  /** Project working directory the session lives in — needed because
   *  readSessionExcerpt resolves the JSONL path from cwd + session_id.
   *  In the global model the coach watches sessions across projects, so
   *  each excerpt fetch needs its own cwd. */
  cwd: string;
  /** Friendly project name shown in the excerpt header for context. */
  projectName: string;
  /** Project id — passed through so ScheduleCard / ProposalCard can
   *  target a real project when the user accepts. */
  projectId: string;
}

interface Props {
  /** Every claude session UUID across EVERY project. Used to gather
   *  excerpts on each tick. The coach is global — there's no per-
   *  project filter. */
  sessions: SessionRef[];
  /** Called when user clicks the ✕ in the header — parent unmounts
   *  the pane and replaces it with a thin "Show coach" toggle. */
  onHide?: () => void;
}

interface CoachMessage {
  uid: string;
  ts: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  streaming?: boolean;
}

let nextUid = 1;
function uid(): string {
  return `c${nextUid++}`;
}
function shortId(s: string | null | undefined, n = 8): string {
  return s ? s.slice(0, n) : '?';
}

export function CoachPane({ sessions, onHide }: Props): React.JSX.Element {
  const [state, setState] = useState<CoachState>({
    enabled: false,
    coach_session_id: null,
    last_run_ms: 0,
  });
  const [coachTermId, setCoachTermId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Workspace cwd the coach session is spawned in. Resolved once on
  // mount via Tauri (~/.deepthix/coach-workspace, created on demand).
  const [coachCwd, setCoachCwd] = useState<string | null>(null);
  // Refs the timer can read without re-binding.
  const coachTermIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<SessionRef[]>(sessions);
  const busyRef = useRef(false);
  const coachCwdRef = useRef<string | null>(null);
  useEffect(() => {
    coachTermIdRef.current = coachTermId;
  }, [coachTermId]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    coachCwdRef.current = coachCwd;
  }, [coachCwd]);
  const streamingMsgIdRef = useRef<string | null>(null);

  // Resolve the coach's workspace dir on mount (one-shot).
  useEffect(() => {
    let cancelled = false;
    void coachWorkspacePath()
      .then((p) => {
        if (cancelled) return;
        console.info('[Deepthix][CoachPane] workspace', { path: p });
        setCoachCwd(p);
      })
      .catch((e) => console.warn('[Deepthix][CoachPane] workspace path failed', e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Load persisted GLOBAL state + message log on mount. The coach is
  // global now — flipping ON in one project means ON for every project
  // — so there's no per-project key. Storage lives at
  // ~/.deepthix/coach.json and ~/.deepthix/coach-messages.json.
  useEffect(() => {
    let cancelled = false;
    void readGlobalCoachState()
      .then((s) => {
        if (cancelled) return;
        setState(s);
      })
      .catch((e) => console.warn('[Deepthix][CoachPane] read state failed', e));
    void readGlobalCoachMessages()
      .then((body) => {
        if (cancelled || !body) return;
        try {
          const parsed = JSON.parse(body) as CoachMessage[];
          if (Array.isArray(parsed)) {
            console.debug('[Deepthix][CoachPane] loaded persisted messages', {
              count: parsed.length,
            });
            setMessages(parsed);
          }
        } catch (e) {
          console.warn('[Deepthix][CoachPane] message log parse failed', e);
        }
      })
      .catch((e) => console.warn('[Deepthix][CoachPane] read messages failed', e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist messages whenever they change (debounced — bursty deltas
  // during streaming would otherwise hammer the disk). Skip the empty
  // initial render so we don't overwrite the persisted log with [] on
  // mount before the read above has populated state.
  const messagesPersistInitDoneRef = useRef(false);
  useEffect(() => {
    if (!messagesPersistInitDoneRef.current && messages.length === 0) return;
    messagesPersistInitDoneRef.current = true;
    const id = setTimeout(() => {
      void writeGlobalCoachMessages(JSON.stringify(messages)).catch((e) =>
        console.warn('[Deepthix][CoachPane] write messages failed', e),
      );
    }, 500);
    return () => clearTimeout(id);
  }, [messages]);

  /** Persist state delta + update local. */
  const updateState = useCallback(
    async (patch: Partial<CoachState>): Promise<CoachState> => {
      const next = { ...state, ...patch };
      setState(next);
      try {
        await writeGlobalCoachState(next);
      } catch (e) {
        console.warn('[Deepthix][CoachPane] write state failed', e);
      }
      return next;
    },
    [state],
  );

  // Subscribe to chat events for the coach term.
  useEffect(() => {
    if (!coachTermId) return;
    let unEvent: (() => void) | null = null;
    let unExit: (() => void) | null = null;
    let cancelled = false;
    const open: Record<string, string> = {};
    void onChatEvent((evt) => {
      if (evt.term_id !== coachTermIdRef.current) return;
      if (evt.stream === 'stderr') return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(evt.line) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = obj.type as string | undefined;
      if (type === 'system' && (obj.subtype as string) === 'init') {
        const sid = obj.session_id as string | undefined;
        if (sid) {
          void chatSetSessionId(coachTermIdRef.current as string, sid).catch(() => {});
          // Persist so the next launch resumes this same coach.
          void updateState({ coach_session_id: sid });
        }
        return;
      }
      if (type === 'stream_event') {
        const ev = obj.event as Record<string, unknown> | undefined;
        const evType = ev?.type as string | undefined;
        if (evType === 'content_block_start') {
          const cb = ev?.content_block as Record<string, unknown> | undefined;
          if ((cb?.type as string) === 'text') {
            const idx = (ev?.index as number) ?? 0;
            const key = `${(ev?.message_id as string) ?? 'm'}|${idx}`;
            const newUid = uid();
            open[key] = newUid;
            streamingMsgIdRef.current = newUid;
            setMessages((prev) => [
              ...prev,
              {
                uid: newUid,
                ts: Date.now(),
                role: 'assistant',
                text: '',
                streaming: true,
              },
            ]);
          }
          return;
        }
        if (evType === 'content_block_delta') {
          const idx = (ev?.index as number) ?? 0;
          const key = `${(ev?.message_id as string) ?? 'm'}|${idx}`;
          const targetUid = open[key];
          if (!targetUid) return;
          const delta = ev?.delta as Record<string, unknown> | undefined;
          if ((delta?.type as string) === 'text_delta') {
            const text = (delta?.text as string) ?? '';
            if (!text) return;
            setMessages((prev) =>
              prev.map((m) => (m.uid === targetUid ? { ...m, text: m.text + text } : m)),
            );
          }
          return;
        }
        if (evType === 'content_block_stop' || evType === 'message_stop') {
          const lastOpen = streamingMsgIdRef.current;
          if (lastOpen) {
            setMessages((prev) =>
              prev.map((m) => (m.uid === lastOpen ? { ...m, streaming: false } : m)),
            );
          }
          if (evType === 'message_stop') streamingMsgIdRef.current = null;
          return;
        }
      }
      if (type === 'result') {
        setBusy(false);
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unEvent = fn;
        }
      })
      .catch((e) => console.error('[Deepthix][CoachPane] subscribe failed', e));
    void onChatExit((evt) => {
      if (evt.term_id !== coachTermIdRef.current) return;
      setBusy(false);
      setCoachTermId(null);
      // Idle reap: not an error — runAnalysis() lazy-spawns the coach
      // again on the next 10-min tick. Stay silent so the user does not
      // see a scary "exited (code ?)" line every reaper cycle.
      if (evt.subtype === 'idle') {
        console.info('[Deepthix][CoachPane] coach reaped on idle — will respawn next tick');
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          uid: uid(),
          ts: Date.now(),
          role: 'system',
          text: `coach exited (code ${evt.code ?? '?'})`,
        },
      ]);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unExit = fn;
        }
      })
      .catch((e) => console.error('[Deepthix][CoachPane] exit subscribe failed', e));
    return () => {
      cancelled = true;
      if (unEvent) unEvent();
      if (unExit) unExit();
    };
  }, [coachTermId, updateState]);

  // Shared in-flight spawn promise. Toggling Coach ON used to fire
  // TWO chatSpawn calls in parallel — once from setEnabled and once
  // from the mount effect that re-runs when state.enabled flips —
  // because both check coachTermIdRef.current === null at the same
  // moment, before either spawn settles. Two claude sonnet processes
  // started, each ~100-200MB resident, and the whole app crawled.
  // Now every caller awaits the same promise.
  const spawnPromiseRef = useRef<Promise<string | null> | null>(null);
  /** Spawn (or resume) the coach session for this project. Idempotent. */
  const spawnCoach = useCallback(async (): Promise<string | null> => {
    if (coachTermIdRef.current) return coachTermIdRef.current;
    if (spawnPromiseRef.current) return spawnPromiseRef.current;
    const p = (async (): Promise<string | null> => {
      try {
        const cwd = coachCwdRef.current;
        if (!cwd) {
          console.warn('[Deepthix][CoachPane] spawn aborted — workspace path not yet resolved');
          return null;
        }
        console.info('[Deepthix][CoachPane] spawning coach', {
          resume: state.coach_session_id ?? null,
          cwd,
        });
        const r = await chatSpawn({
          cwd,
          skip_permissions: true,
          model: 'sonnet',
          resume_session_id: state.coach_session_id ?? null,
        });
        setCoachTermId(r.term_id);
        coachTermIdRef.current = r.term_id;
        return r.term_id;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][CoachPane] spawnCoach failed', e);
        setError(msg);
        return null;
      } finally {
        spawnPromiseRef.current = null;
      }
    })();
    spawnPromiseRef.current = p;
    return p;
  }, [state.coach_session_id]);

  /** Read excerpts from every claude session and feed the coach. */
  const runAnalysis = useCallback(async (): Promise<void> => {
    console.info('[Deepthix][CoachPane] runAnalysis: invoked', {
      busy: busyRef.current,
      sessions: sessionsRef.current.length,
      hasTerm: !!coachTermIdRef.current,
    });
    // CRITICAL: claim the busy slot SYNCHRONOUSLY before any await.
    // Otherwise concurrent callers (mount effect re-firing on every
    // state change + interval + manual click + setEnabled) all pass
    // the busy check together and queue 10+ runs in parallel — user
    // saw a stack of "📥 Analysing last 10 turns of 2 sessions…"
    // bubbles, the same prompt was shipped to the coach 10 times.
    if (busyRef.current) {
      console.debug('[Deepthix][CoachPane] tick skipped — coach still busy');
      return;
    }
    busyRef.current = true;
    setBusy(true);

    // We hold the busy slot for the WHOLE call. If we ship a prompt
    // to the coach, we leave it held — the `result` chat_event clears
    // it. If we bail early (no sessions / no excerpts / spawn failed
    // / threw), we MUST release in finally; otherwise the next 10-min
    // tick is silently skipped forever and the user thinks the coach
    // is stuck.
    let shippedToClaude = false;
    try {
      let term = coachTermIdRef.current;
      if (!term) {
        term = await spawnCoach();
        if (!term) {
          console.warn('[Deepthix][CoachPane] tick aborted — spawnCoach returned null');
          return;
        }
      }
      const sessions = sessionsRef.current;
      if (sessions.length === 0) {
        console.debug('[Deepthix][CoachPane] tick skipped — no sessions in project');
        setMessages((prev) => [
          ...prev,
          {
            uid: uid(),
            ts: Date.now(),
            role: 'system',
            text: 'Waiting for at least one claude session in this project to analyse.',
          },
        ]);
        return;
      }
      setError(null);
      const blocks: string[] = [];
      for (const s of sessions) {
        // Each session lives under its own project cwd (the coach is
        // global — sessions span every project), so we resolve the
        // JSONL path with that session's cwd, not the coach's workspace.
        const ex = await readSessionExcerpt(s.cwd, s.sessionId, EXCERPT_TURNS_PER_SESSION);
        if (!ex.trim()) continue;
        blocks.push(`### ${s.projectName} · ${s.label} (${shortId(s.sessionId)})\n${ex}`);
      }
      if (blocks.length === 0) {
        setMessages((prev) => [
          ...prev,
          {
            uid: uid(),
            ts: Date.now(),
            role: 'system',
            text: 'No new activity to analyse.',
          },
        ]);
        return;
      }
      const prompt = `${COACH_PROMPT_PREFIX}${blocks.join('\n\n')}`;
      setMessages((prev) => [
        ...prev,
        {
          uid: uid(),
          ts: Date.now(),
          role: 'system',
          text: `📥 Analysing last ${EXCERPT_TURNS_PER_SESSION} turns of ${sessions.length} session${sessions.length > 1 ? 's' : ''}…`,
        },
      ]);
      await chatSendUserText(term, prompt);
      void updateState({ last_run_ms: Date.now() });
      shippedToClaude = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][CoachPane] runAnalysis failed', e);
      setError(msg);
    } finally {
      if (!shippedToClaude) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [spawnCoach, updateState]);

  // Toggle handler — flips enabled, spawns/kills coach accordingly.
  const setEnabled = useCallback(
    async (next: boolean): Promise<void> => {
      if (next === state.enabled) return;
      const updated = await updateState({ enabled: next });
      if (next) {
        // Start: spawn (or resume) the coach. The interval effect
        // will pick up from `enabled` flipping.
        if (!coachTermIdRef.current) await spawnCoach();
        // Optionally kick off an immediate analysis if it's been a
        // while since the last run.
        const sinceLast = Date.now() - (updated.last_run_ms || 0);
        if (sinceLast >= COACH_INTERVAL_MS) {
          void runAnalysis();
        }
      } else {
        // Stop: kill the coach process. State flag stays for clarity
        // (and to remember the coach_session_id for next time).
        const term = coachTermIdRef.current;
        if (term) {
          try {
            await chatKill(term);
          } catch (e) {
            console.warn('[Deepthix][CoachPane] kill failed', e);
          }
        }
        setCoachTermId(null);
        coachTermIdRef.current = null;
      }
    },
    [state.enabled, updateState, spawnCoach, runAnalysis],
  );

  // Stable refs so the interval/mount effects only run on toggle
  // ON/OFF, not on every state.last_run_ms update (which used to
  // re-create the interval and re-arm the mount auto-trigger every
  // tick — wasteful + amplified the runAnalysis-storm bug).
  const runAnalysisRef = useRef(runAnalysis);
  useEffect(() => {
    runAnalysisRef.current = runAnalysis;
  }, [runAnalysis]);
  const spawnCoachRef = useRef(spawnCoach);
  useEffect(() => {
    spawnCoachRef.current = spawnCoach;
  }, [spawnCoach]);
  const lastRunMsRef = useRef(state.last_run_ms);
  useEffect(() => {
    lastRunMsRef.current = state.last_run_ms;
  }, [state.last_run_ms]);

  // 10-minute interval timer when enabled. Fires runAnalysis each
  // tick. Cleared cleanly on toggle-off / unmount / project switch.
  useEffect(() => {
    if (!state.enabled) return;
    const id = setInterval(() => {
      void runAnalysisRef.current();
    }, COACH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state.enabled]);

  // Auto-spawn coach + kick off the first analysis on mount when the
  // user had the coach enabled before quitting (or just toggled it on
  // and we're racing the toggle handler).
  useEffect(() => {
    if (!state.enabled) return;
    if (coachTermIdRef.current) return;
    let cancelled = false;
    void (async () => {
      const term = await spawnCoachRef.current();
      if (cancelled) {
        // Cleanup fired while we were spawning — kill the orphan we
        // just created. Without this, switching away from the coach
        // mid-spawn would leak a sonnet process for 30 min until the
        // backend idle reaper catches it.
        if (term) {
          await chatKill(term).catch((e) =>
            console.warn('[Deepthix][CoachPane] kill-on-cancel failed', e),
          );
        }
        return;
      }
      if (!term) return;
      const sinceLast = Date.now() - (lastRunMsRef.current || 0);
      if (sinceLast >= COACH_INTERVAL_MS) {
        console.info(
          '[Deepthix][CoachPane] mount: triggering first analysis (stale or never run)',
          { sinceLast, lastRunMs: lastRunMsRef.current },
        );
        void runAnalysisRef.current();
      } else {
        console.debug('[Deepthix][CoachPane] mount: skipping immediate run (recent)', {
          sinceLast,
        });
      }
    })();
    return () => {
      cancelled = true;
      // Kill the coach claude on unmount. The conversation lives in
      // state.coach_session_id, so the next mount will --resume it; we
      // don't lose history. But the OS process must die or we leak a
      // sonnet child every time SessionsTopArea re-mounts (project
      // switch, hot reload, recovery from crash, etc).
      const term = coachTermIdRef.current;
      if (term) {
        coachTermIdRef.current = null;
        void chatKill(term).catch((e) =>
          console.warn('[Deepthix][CoachPane] kill-on-unmount failed', e),
        );
      }
    };
  }, [state.enabled]);

  const interrupt = useCallback(() => {
    if (!coachTermId) return;
    void chatInterrupt(coachTermId).catch((e) =>
      console.warn('[Deepthix][CoachPane] interrupt failed', e),
    );
  }, [coachTermId]);

  // Newest recommendation always at the TOP. User explicitly asked:
  // "toujours afficher la dernière recommandation tout en haut".
  // So we reverse the message order in render (below) and snap the
  // scroll to 0 on every new message — the latest always lands in
  // view at the top of the pane. The user can scroll DOWN to read
  // older proposals (the container has overflow:auto + min-height:0
  // so internal scrolling works regardless of message volume).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [messages]);

  const nextRunIn = useMemo(() => {
    if (!state.enabled) return null;
    // last_run_ms === 0 means we've never completed an analysis. The
    // raw formula returns 0 here (now - 0 is huge), which read as a
    // bogus "in 0m00s" — say what's actually happening instead.
    if (!state.last_run_ms) return 'starting…';
    const since = Date.now() - state.last_run_ms;
    const remaining = Math.max(0, COACH_INTERVAL_MS - since);
    if (remaining <= 1000) return 'any moment';
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    return `${m}m${s.toString().padStart(2, '0')}s`;
  }, [state.enabled, state.last_run_ms]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg)',
        fontFamily: 'var(--font-pixel)',
        color: 'var(--color-text)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '12px 16px',
          background: 'var(--color-bg-dark)',
          borderBottom: `2px solid ${state.enabled ? 'var(--color-accent)' : 'var(--color-border)'}`,
          fontSize: 12,
          transition: 'border-color 200ms ease, box-shadow 200ms ease',
          // Subtle accent halo when ON to make the header read as a
          // distinct section even with theme variations.
          boxShadow: state.enabled ? 'inset 0 0 0 1px var(--color-accent)' : 'none',
        }}
      >
        <ToggleSwitch
          enabled={state.enabled}
          onChange={(next) => void setEnabled(next)}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                fontWeight: 'bold',
                fontSize: 15,
                letterSpacing: '0.06em',
                color: state.enabled ? 'var(--color-accent)' : 'var(--color-text)',
                transition: 'color 200ms ease',
              }}
            >
              COACH
            </span>
            <span
              style={{
                fontSize: 10,
                padding: '1px 6px',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                opacity: 0.85,
                letterSpacing: '0.05em',
              }}
            >
              SONNET
            </span>
            <span
              style={{
                fontSize: 10,
                padding: '1px 6px',
                background: state.enabled ? 'var(--color-accent)' : 'transparent',
                color: state.enabled ? 'var(--color-bg-dark)' : 'var(--color-text-muted)',
                border: `1px solid ${state.enabled ? 'var(--color-accent)' : 'var(--color-border)'}`,
                fontWeight: 'bold',
                letterSpacing: '0.05em',
                transition: 'background 200ms ease, color 200ms ease',
              }}
            >
              {state.enabled ? 'ON' : 'OFF'}
            </span>
            {busy && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 10,
                  color: 'var(--color-accent)',
                  letterSpacing: '0.05em',
                  fontWeight: 'bold',
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--color-accent)',
                    animation: 'pulse 1.2s ease-in-out infinite',
                  }}
                />
                ANALYSING
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 11,
              opacity: 0.75,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            {state.enabled ? (
              <>
                <span>
                  📡 watching{' '}
                  <strong>
                    {sessions.length} session{sessions.length === 1 ? '' : 's'}
                  </strong>{' '}
                  across all projects
                </span>
                <span style={{ opacity: 0.5 }}>·</span>
                <span>
                  next run <strong>{nextRunIn}</strong>
                </span>
              </>
            ) : (
              <span>Toggle ON — Sonnet reviews every claude session in every project, every 10 min.</span>
            )}
          </div>
        </div>
        {state.enabled && !busy && (
          <button
            type="button"
            onClick={() => void runAnalysis()}
            title="Force an analysis right now (don't wait the 10 min)"
            style={headerBtn(false)}
          >
            ▶ Run now
          </button>
        )}
        {busy && (
          <button
            type="button"
            onClick={interrupt}
            title="Stop the running analysis"
            style={headerBtn(true)}
          >
            ⏹ Stop
          </button>
        )}
        {onHide && (
          <button
            type="button"
            onClick={onHide}
            title="Masquer ce panneau (réaffichable via le bouton 👁 en haut)"
            style={{
              ...headerBtn(false),
              padding: '4px 10px',
              opacity: 0.7,
            }}
          >
            ✕
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: '6px 10px',
            background: 'var(--color-danger)',
            color: 'var(--color-bg-dark)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {!state.enabled && messages.length === 0 ? (
          <EmptyCoach hasSessions={sessions.length > 0} />
        ) : state.enabled && messages.length === 0 ? (
          <WatchingPlaceholder
            sessions={sessions.length}
            nextRunIn={nextRunIn}
            onRunNow={() => void runAnalysis()}
            busy={busy}
          />
        ) : (
          messages
            .slice()
            .reverse()
            .map((m) => (
              <CoachBubble
                key={m.uid}
                m={m}
                // Proposals append to CLAUDE.md and schedules attach
                // to a session — both need a project anchor. With a
                // global coach there's no single "current project",
                // so we pin to the FIRST claude session in the list
                // (typically the one in the user's most-used project).
                // TODO: let the user pick the target per card.
                cwd={sessions[0]?.cwd ?? ''}
                projectId={sessions[0]?.projectId ?? ''}
                proxySessionId={sessions[0]?.sessionId ?? null}
              />
            ))
        )}
      </div>
    </div>
  );
}

function ToggleSwitch({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      title={enabled ? 'Click to turn coach OFF' : 'Click to turn coach ON'}
      style={{
        position: 'relative',
        width: 56,
        height: 26,
        background: enabled ? 'var(--color-accent)' : 'var(--color-bg)',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
        transition: 'background 200ms ease',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: enabled ? 30 : 2,
          width: 18,
          height: 18,
          background: enabled ? 'var(--color-bg-dark)' : 'var(--color-text)',
          transition: 'left 200ms cubic-bezier(0.5, 0, 0.2, 1.4), background 200ms ease',
        }}
      />
      <span
        style={{
          position: 'absolute',
          top: '50%',
          transform: 'translateY(-50%)',
          left: enabled ? 6 : undefined,
          right: enabled ? undefined : 6,
          fontFamily: 'var(--font-pixel)',
          fontSize: 8,
          color: enabled ? 'var(--color-bg-dark)' : 'var(--color-text)',
          opacity: 0.85,
          letterSpacing: '0.05em',
          pointerEvents: 'none',
        }}
      >
        {enabled ? 'ON' : 'OFF'}
      </span>
    </button>
  );
}

function headerBtn(danger: boolean): React.CSSProperties {
  return {
    padding: '4px 12px',
    background: danger ? 'var(--color-danger)' : 'var(--color-accent)',
    color: 'var(--color-bg-dark)',
    border: '2px solid var(--color-border)',
    boxShadow: 'var(--shadow-pixel)',
    fontFamily: 'var(--font-pixel)',
    fontSize: 11,
    cursor: 'pointer',
    flexShrink: 0,
  };
}

/** Shown when the Coach is ON but hasn't run yet (or just turned on
 *  this launch). Lets the user kick off an immediate tick instead of
 *  waiting the full 10 min just to see something happen. */
function WatchingPlaceholder({
  sessions,
  nextRunIn,
  onRunNow,
  busy,
}: {
  sessions: number;
  nextRunIn: string | null;
  onRunNow: () => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 32,
      }}
    >
      <div
        style={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: 'var(--color-accent)',
          animation: 'pulse 1.6s ease-in-out infinite',
        }}
      />
      <div style={{ fontSize: 13, fontWeight: 'bold' }}>
        Coach is watching {sessions} session{sessions === 1 ? '' : 's'}
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, maxWidth: 380 }}>
        {nextRunIn === 'starting…' || nextRunIn === 'any moment' ? (
          <>
            First analysis is starting now — proposals will appear here in a few seconds. Or
            trigger one manually —
          </>
        ) : (
          <>
            It will analyse your activity automatically in <strong>{nextRunIn}</strong> and propose
            improvements you can append to <code>CLAUDE.md</code> with one click. Or trigger an
            analysis right now —
          </>
        )}
      </div>
      <button
        type="button"
        onClick={onRunNow}
        disabled={busy || sessions === 0}
        style={{
          padding: '8px 18px',
          background: busy || sessions === 0 ? 'transparent' : 'var(--color-accent)',
          color: busy || sessions === 0 ? 'inherit' : 'var(--color-bg-dark)',
          border: '2px solid var(--color-border)',
          boxShadow: busy || sessions === 0 ? 'none' : 'var(--shadow-pixel)',
          cursor: busy || sessions === 0 ? 'default' : 'pointer',
          fontFamily: 'var(--font-pixel)',
          fontSize: 12,
          opacity: busy || sessions === 0 ? 0.5 : 1,
        }}
      >
        ▶ Run analysis now
      </button>
    </div>
  );
}

function EmptyCoach({ hasSessions }: { hasSessions: boolean }): React.JSX.Element {
  const itemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    fontSize: 12,
    lineHeight: 1.5,
  };
  const iconStyle: React.CSSProperties = {
    fontSize: 16,
    minWidth: 22,
    textAlign: 'center',
    paddingTop: 1,
  };
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'left',
        padding: '40px 24px',
      }}
    >
      <div
        style={{
          fontSize: 32,
          opacity: 0.55,
          letterSpacing: '0.05em',
        }}
      >
        🧠
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 'bold',
          letterSpacing: '0.04em',
          color: 'var(--color-text)',
          textAlign: 'center',
        }}
      >
        Meta-coach for your claude sessions
      </div>
      <div
        style={{
          fontSize: 11,
          opacity: 0.7,
          maxWidth: 460,
          textAlign: 'center',
          lineHeight: 1.5,
        }}
      >
        A Sonnet sub-session that watches every claude window across every project and proposes
        improvements you can accept with one click.
      </div>
      <div
        style={{
          maxWidth: 460,
          width: '100%',
          background: 'var(--color-bg-dark)',
          border: '2px solid var(--color-border)',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={itemStyle}>
          <span style={iconStyle}>📡</span>
          <span>
            Reads <strong>every active claude session</strong> in every project every 10 min.
          </span>
        </div>
        <div style={itemStyle}>
          <span style={iconStyle}>📝</span>
          <span>
            Proposes <strong>memory rules</strong> you can append to{' '}
            <code style={{ background: 'var(--color-bg)', padding: '0 4px' }}>CLAUDE.md</code> with
            one click.
          </span>
        </div>
        <div style={itemStyle}>
          <span style={iconStyle}>⏱</span>
          <span>
            Proposes <strong>schedules</strong> for recurring jobs worth automating.
          </span>
        </div>
        <div style={itemStyle}>
          <span style={iconStyle}>📊</span>
          <span>
            Pins <strong>project insights</strong> to your dashboard via its Write tool.
          </span>
        </div>
      </div>
      <div
        style={{
          fontSize: 11,
          opacity: 0.55,
          textAlign: 'center',
          maxWidth: 460,
        }}
      >
        Flip the toggle in the header to start.
        {!hasSessions && (
          <>
            <br />
            <strong style={{ color: 'var(--color-warning, #f59e0b)' }}>
              Open at least one claude session in any project first.
            </strong>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Parse `<proposal><title>…</title><why>…</why><memory>…</memory></proposal>`
 * blocks from the coach's free-form text. Returns an empty array if
 * none are found — caller falls back to plain markdown render.
 *
 * Tolerant: missing <memory> is allowed (proposal without memory ask),
 * tags can have whitespace, content can span multiple lines.
 */
interface Proposal {
  title: string;
  why: string;
  memory: string;
}
function parseProposals(text: string): Proposal[] {
  const out: Proposal[] = [];
  const blockRe = /<proposal>([\s\S]*?)<\/proposal>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const inner = m[1];
    const title = (inner.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
    const why = (inner.match(/<why>([\s\S]*?)<\/why>/i)?.[1] ?? '').trim();
    const memory = (inner.match(/<memory>([\s\S]*?)<\/memory>/i)?.[1] ?? '').trim();
    if (title || why || memory) out.push({ title, why, memory });
  }
  return out;
}

interface ScheduleProposal {
  title: string;
  why: string;
  prompt: string;
  everyMinutes: number | null;
  atIso: string | null;
}
function parseSchedules(text: string): ScheduleProposal[] {
  const out: ScheduleProposal[] = [];
  const blockRe = /<schedule>([\s\S]*?)<\/schedule>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const inner = m[1];
    const title = (inner.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
    const why = (inner.match(/<why>([\s\S]*?)<\/why>/i)?.[1] ?? '').trim();
    const prompt = (inner.match(/<prompt>([\s\S]*?)<\/prompt>/i)?.[1] ?? '').trim();
    const minutesRaw = (inner.match(/<every_minutes>([\s\S]*?)<\/every_minutes>/i)?.[1] ?? '').trim();
    const atIso = (inner.match(/<at_iso>([\s\S]*?)<\/at_iso>/i)?.[1] ?? '').trim();
    const everyMinutes = minutesRaw ? Number.parseInt(minutesRaw, 10) : NaN;
    out.push({
      title,
      why,
      prompt,
      everyMinutes: Number.isFinite(everyMinutes) && everyMinutes > 0 ? everyMinutes : null,
      atIso: atIso || null,
    });
  }
  return out;
}

interface WorkflowProposal {
  title: string;
  why: string;
  description: string;
  prompt: string;
  tags: string[];
}
function parseWorkflowProposals(text: string): WorkflowProposal[] {
  const out: WorkflowProposal[] = [];
  const blockRe = /<workflow>([\s\S]*?)<\/workflow>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const inner = m[1];
    const title = (inner.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
    const why = (inner.match(/<why>([\s\S]*?)<\/why>/i)?.[1] ?? '').trim();
    const description = (inner.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '').trim();
    const prompt = (inner.match(/<prompt>([\s\S]*?)<\/prompt>/i)?.[1] ?? '').trim();
    const tagsRaw = (inner.match(/<tags>([\s\S]*?)<\/tags>/i)?.[1] ?? '').trim();
    const tags = tagsRaw
      ? tagsRaw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
      : [];
    out.push({ title, why, description, prompt, tags });
  }
  return out;
}

type ProposalDecision = 'pending' | 'accepted' | 'dismissed';

// memo: every text_delta on the streaming message triggers setMessages,
// which re-renders the whole pane. Without memo we'd re-run
// parseProposals + parseSchedules + ReactMarkdown on EVERY existing
// bubble for every delta — coach analyses with many proposals were
// pegging the CPU and making the whole app feel laggy.
const CoachBubble = memo(_CoachBubble);
function _CoachBubble({
  m,
  cwd,
  projectId,
  proxySessionId,
}: {
  m: CoachMessage;
  cwd: string;
  projectId: string;
  proxySessionId: string | null;
}): React.JSX.Element {
  if (m.role === 'system') {
    return (
      <div
        className="dt-chat-msg"
        style={{
          alignSelf: 'center',
          fontSize: 11,
          opacity: 0.6,
          padding: '2px 10px',
          border: '1px dashed var(--color-border)',
        }}
      >
        {m.text}
      </div>
    );
  }
  // Streaming with no content yet → just a caret.
  if (m.streaming && m.text.length === 0) {
    return (
      <div
        className="dt-chat-msg"
        style={{
          alignSelf: 'flex-start',
          padding: '8px 10px',
          background: 'var(--color-bg-dark)',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          fontSize: 13,
        }}
      >
        <span style={{ opacity: 0.5 }}>▌</span>
      </div>
    );
  }

  // While streaming we just render a plain "thinking" preview — don't
  // run the XML parsers / markdown on every text_delta. Coach answers
  // are 1–5 cards, sometimes ~5KB each; parsing on every chunk was
  // pegging the CPU. Cards land in their final form when streaming ends.
  if (m.streaming) {
    return (
      <div
        className="dt-chat-msg"
        style={{
          alignSelf: 'flex-start',
          maxWidth: '92%',
          background: 'var(--color-bg-dark)',
          color: 'var(--color-text)',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          padding: '8px 10px',
          fontSize: 13,
          lineHeight: 1.45,
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
        }}
      >
        <div style={{ fontSize: 10, opacity: 0.6, marginBottom: 4 }}>
          coach · writing…
        </div>
        <span style={{ opacity: 0.5 }}>▌</span>
        {m.text.length > 600 ? `${m.text.slice(0, 600)}…` : m.text}
      </div>
    );
  }

  const proposals = parseProposals(m.text);
  const schedules = parseSchedules(m.text);
  const workflows = parseWorkflowProposals(m.text);

  // No structured cards → coach went off-format. Render as markdown
  // so we never lose information.
  if (proposals.length === 0 && schedules.length === 0 && workflows.length === 0) {
    return (
      <div
        className="dt-chat-msg"
        style={{
          alignSelf: 'flex-start',
          maxWidth: '92%',
          background: 'var(--color-bg-dark)',
          color: 'var(--color-text)',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          padding: '8px 10px',
          fontSize: 13,
          lineHeight: 1.45,
          wordBreak: 'break-word',
        }}
      >
        <div style={{ fontSize: 10, opacity: 0.6, marginBottom: 4 }}>
          coach · {new Date(m.ts).toLocaleTimeString()}
        </div>
        {m.streaming ? (
          <span style={{ opacity: 0.5 }}>▌ {m.text}</span>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
        )}
      </div>
    );
  }

  const cardCount = proposals.length + schedules.length + workflows.length;
  return (
    <div className="dt-chat-msg" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          alignSelf: 'flex-start',
          fontSize: 10,
          opacity: 0.6,
          padding: '0 4px',
        }}
      >
        coach · {new Date(m.ts).toLocaleTimeString()} · {cardCount} card
        {cardCount === 1 ? '' : 's'}
      </div>
      {proposals.map((p, idx) => (
        <ProposalCard key={`${m.uid}-p-${idx}`} proposal={p} cwd={cwd} />
      ))}
      {schedules.map((s, idx) => (
        <ScheduleCard
          key={`${m.uid}-s-${idx}`}
          schedule={s}
          projectId={projectId}
          proxySessionId={proxySessionId}
        />
      ))}
      {workflows.map((w, idx) => (
        <WorkflowCard key={`${m.uid}-w-${idx}`} workflow={w} />
      ))}
    </div>
  );
}

const ProposalCard = memo(ProposalCardImpl);
function ProposalCardImpl({
  proposal,
  cwd,
}: {
  proposal: Proposal;
  cwd: string;
}): React.JSX.Element {
  const [decision, setDecision] = useState<ProposalDecision>('pending');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onAccept = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      if (proposal.memory) {
        await appendToClaudeMd(cwd, proposal.memory);
      }
      setDecision('accepted');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][CoachPane] append failed', e);
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }, [busy, proposal.memory, cwd]);

  const onDismiss = useCallback((): void => {
    setDecision('dismissed');
  }, []);

  const accent =
    decision === 'accepted'
      ? 'var(--color-success, #34d399)'
      : decision === 'dismissed'
        ? 'var(--color-border)'
        : 'var(--color-accent)';

  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '92%',
        background: 'var(--color-bg-dark)',
        color: 'var(--color-text)',
        border: '2px solid var(--color-border)',
        borderLeft: `4px solid ${accent}`,
        boxShadow: 'var(--shadow-pixel)',
        padding: '10px 12px',
        fontSize: 13,
        opacity: decision === 'dismissed' ? 0.45 : 1,
        textDecoration: decision === 'dismissed' ? 'line-through' : 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ fontWeight: 'bold', lineHeight: 1.3 }}>{proposal.title || '(no title)'}</div>
      {proposal.why && (
        <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4 }}>{proposal.why}</div>
      )}
      {proposal.memory && (
        <pre
          style={{
            margin: 0,
            padding: '6px 8px',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            fontFamily: 'Menlo, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 140,
            overflow: 'auto',
          }}
        >
          {proposal.memory}
        </pre>
      )}
      {err && <div style={{ fontSize: 11, color: 'var(--color-danger)' }}>error: {err}</div>}
      {decision === 'pending' ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          <button
            type="button"
            onClick={() => void onAccept()}
            disabled={busy}
            title={
              proposal.memory
                ? 'Append the memory block to CLAUDE.md'
                : 'Mark as accepted (no memory text to add)'
            }
            style={cardBtn(true, busy)}
          >
            {busy ? '…' : proposal.memory ? '✓ Yes — add to CLAUDE.md' : '✓ Yes'}
          </button>
          <button type="button" onClick={onDismiss} style={cardBtn(false, false)}>
            ✗ No
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 10, opacity: 0.7 }}>
          {decision === 'accepted'
            ? proposal.memory
              ? '✓ added to CLAUDE.md'
              : '✓ accepted'
            : '✗ dismissed'}
        </div>
      )}
    </div>
  );
}

const ScheduleCard = memo(ScheduleCardImpl);
function ScheduleCardImpl({
  schedule,
  projectId,
  proxySessionId,
}: {
  schedule: ScheduleProposal;
  projectId: string;
  proxySessionId: string | null;
}): React.JSX.Element {
  const [decision, setDecision] = useState<ProposalDecision>('pending');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cadenceLabel = useMemo(() => {
    if (schedule.everyMinutes != null) {
      const m = schedule.everyMinutes;
      if (m % 1440 === 0) return `every ${m / 1440}d`;
      if (m % 60 === 0) return `every ${m / 60}h`;
      return `every ${m}m`;
    }
    if (schedule.atIso) {
      const d = new Date(schedule.atIso);
      return Number.isFinite(d.getTime())
        ? `once at ${d.toLocaleString()}`
        : `once at ${schedule.atIso}`;
    }
    return 'cadence missing';
  }, [schedule]);

  const onAccept = useCallback(async (): Promise<void> => {
    if (busy) return;
    if (!proxySessionId) {
      setErr('no claude session in this project to attach the schedule to');
      return;
    }
    if (!schedule.prompt) {
      setErr('schedule prompt is empty — coach must include <prompt>');
      return;
    }
    let cadence: Cadence | null = null;
    if (schedule.everyMinutes != null) {
      cadence = { kind: 'interval', every_seconds: schedule.everyMinutes * 60 };
    } else if (schedule.atIso) {
      const ms = Date.parse(schedule.atIso);
      if (!Number.isFinite(ms)) {
        setErr(`invalid at_iso: ${schedule.atIso}`);
        return;
      }
      cadence = { kind: 'once', at_ms: ms };
    } else {
      setErr('schedule needs <every_minutes> or <at_iso>');
      return;
    }
    setBusy(true);
    try {
      await createSchedule({
        name: schedule.title || 'coach-suggested schedule',
        target_session_id: proxySessionId,
        target_project_id: projectId,
        prompt: schedule.prompt,
        cadence,
      });
      console.info('[Deepthix][CoachPane] schedule created', {
        title: schedule.title,
        cadence,
      });
      setDecision('accepted');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][CoachPane] createSchedule failed', e);
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }, [busy, proxySessionId, projectId, schedule]);

  const onDismiss = useCallback((): void => setDecision('dismissed'), []);

  const accent =
    decision === 'accepted'
      ? 'var(--color-success, #34d399)'
      : decision === 'dismissed'
        ? 'var(--color-border)'
        : 'var(--color-accent-bright, var(--color-accent))';

  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '92%',
        background: 'var(--color-bg-dark)',
        color: 'var(--color-text)',
        border: '2px solid var(--color-border)',
        borderLeft: `4px solid ${accent}`,
        boxShadow: 'var(--shadow-pixel)',
        padding: '10px 12px',
        fontSize: 13,
        opacity: decision === 'dismissed' ? 0.45 : 1,
        textDecoration: decision === 'dismissed' ? 'line-through' : 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 'bold', lineHeight: 1.3 }}>
          {schedule.title || '(no title)'}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: '1px 6px',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            opacity: 0.85,
          }}
        >
          ⏱ {cadenceLabel}
        </span>
      </div>
      {schedule.why && (
        <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4 }}>{schedule.why}</div>
      )}
      {schedule.prompt && (
        <pre
          style={{
            margin: 0,
            padding: '6px 8px',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            fontFamily: 'Menlo, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 140,
            overflow: 'auto',
          }}
          title="Prompt the schedule will fire on each tick"
        >
          {schedule.prompt}
        </pre>
      )}
      {err && <div style={{ fontSize: 11, color: 'var(--color-danger)' }}>error: {err}</div>}
      {decision === 'pending' ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          <button
            type="button"
            onClick={() => void onAccept()}
            disabled={busy || !proxySessionId}
            title={
              proxySessionId
                ? 'Create the schedule against this project'
                : 'Open a claude session first'
            }
            style={cardBtn(true, busy || !proxySessionId)}
          >
            {busy ? '…' : '✓ Yes — create schedule'}
          </button>
          <button type="button" onClick={onDismiss} style={cardBtn(false, false)}>
            ✗ No
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 10, opacity: 0.7 }}>
          {decision === 'accepted'
            ? '⏱ schedule created — manage it in the SCHEDULE tab'
            : '✗ dismissed'}
        </div>
      )}
    </div>
  );
}

const WorkflowCard = memo(WorkflowCardImpl);
function WorkflowCardImpl({
  workflow,
}: {
  workflow: WorkflowProposal;
}): React.JSX.Element {
  const [decision, setDecision] = useState<ProposalDecision>('pending');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onAccept = useCallback(async (): Promise<void> => {
    if (busy) return;
    if (!workflow.prompt) {
      setErr('workflow prompt is empty — coach must include <prompt>');
      return;
    }
    setBusy(true);
    try {
      await createWorkflow({
        name: workflow.title || 'Coach-suggested workflow',
        description: workflow.description,
        prompt: workflow.prompt,
        tags: workflow.tags,
      });
      console.info('[Deepthix][CoachPane] workflow created from coach', {
        title: workflow.title,
      });
      setDecision('accepted');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][CoachPane] createWorkflow failed', e);
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }, [busy, workflow]);

  const onDismiss = useCallback((): void => setDecision('dismissed'), []);

  const accent =
    decision === 'accepted'
      ? 'var(--color-status-success, #34d399)'
      : decision === 'dismissed'
        ? 'var(--color-border)'
        : 'var(--color-accent)';

  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '92%',
        background: 'var(--color-bg-dark)',
        color: 'var(--color-text)',
        border: '2px solid var(--color-border)',
        borderLeft: `4px solid ${accent}`,
        boxShadow: 'var(--shadow-pixel)',
        padding: '10px 12px',
        fontSize: 13,
        opacity: decision === 'dismissed' ? 0.45 : 1,
        textDecoration: decision === 'dismissed' ? 'line-through' : 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 'bold', lineHeight: 1.3 }}>
          {workflow.title || '(no title)'}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: '1px 6px',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            opacity: 0.85,
            letterSpacing: '0.05em',
          }}
        >
          🧰 WORKFLOW
        </span>
        {workflow.tags.map((t) => (
          <span
            key={t}
            style={{
              fontSize: 9,
              padding: '1px 5px',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              opacity: 0.7,
            }}
          >
            #{t}
          </span>
        ))}
      </div>
      {workflow.why && (
        <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4 }}>{workflow.why}</div>
      )}
      {workflow.description && (
        <div style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.4 }}>
          {workflow.description}
        </div>
      )}
      {workflow.prompt && (
        <pre
          style={{
            margin: 0,
            padding: '6px 8px',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            fontFamily: 'Menlo, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 160,
            overflow: 'auto',
          }}
          title="Prompt the workflow will fire on Run"
        >
          {workflow.prompt}
        </pre>
      )}
      {err && <div style={{ fontSize: 11, color: 'var(--color-danger)' }}>error: {err}</div>}
      {decision === 'pending' ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          <button
            type="button"
            onClick={() => void onAccept()}
            disabled={busy}
            title="Save this workflow to the catalog — runnable from the WORKFLOW tab"
            style={cardBtn(true, busy)}
          >
            {busy ? '…' : '✓ Yes — save workflow'}
          </button>
          <button type="button" onClick={onDismiss} style={cardBtn(false, false)}>
            ✗ No
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 10, opacity: 0.7 }}>
          {decision === 'accepted'
            ? '🧰 saved — find it in the WORKFLOW tab'
            : '✗ dismissed'}
        </div>
      )}
    </div>
  );
}

function cardBtn(primary: boolean, busy: boolean): React.CSSProperties {
  return {
    padding: '4px 12px',
    background: primary && !busy ? 'var(--color-accent)' : 'transparent',
    color: primary && !busy ? 'var(--color-bg-dark)' : 'inherit',
    border: '2px solid var(--color-border)',
    boxShadow: primary && !busy ? 'var(--shadow-pixel)' : 'none',
    cursor: busy ? 'default' : 'pointer',
    fontFamily: 'var(--font-pixel)',
    fontSize: 11,
    opacity: busy ? 0.5 : 1,
  };
}
