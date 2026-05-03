/* eslint-disable deepthix/no-inline-colors */
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
  createSchedule,
  readProjectCoachMessages,
  readProjectCoachState,
  readSessionExcerpt,
  writeProjectCoachMessages,
  writeProjectCoachState,
} from '../tauri/commands';
import { onChatEvent, onChatExit } from '../tauri/events';

const COACH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const EXCERPT_TURNS_PER_SESSION = 10;
const COACH_PROMPT_PREFIX = `You are a coaching agent watching multiple claude sessions in a project. Your job is two-fold:

(A) PROPOSALS — emit cards the user can Accept/Reject in the UI. Two kinds:

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
}

interface Props {
  /** Project id (storage key for coach.json). */
  projectId: string;
  /** Project cwd — coach is spawned here so it sees CLAUDE.md / files. */
  cwd: string;
  /** Every claude session UUID in the project. Used to gather excerpts
   *  on each tick. */
  sessions: SessionRef[];
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

export function CoachPane({ projectId, cwd, sessions }: Props): React.JSX.Element {
  const [state, setState] = useState<CoachState>({
    enabled: false,
    coach_session_id: null,
    last_run_ms: 0,
  });
  const [coachTermId, setCoachTermId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refs the timer can read without re-binding.
  const coachTermIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<SessionRef[]>(sessions);
  const busyRef = useRef(false);
  const cwdRef = useRef(cwd);
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
    cwdRef.current = cwd;
  }, [cwd]);
  const streamingMsgIdRef = useRef<string | null>(null);

  // Load persisted state + message log on project change. Without
  // message persistence the user lost every proposal on reload —
  // the pane sat at the empty "Coach is watching" placeholder even
  // after dozens of analyses.
  useEffect(() => {
    let cancelled = false;
    void readProjectCoachState(projectId)
      .then((s) => {
        if (cancelled) return;
        setState(s);
      })
      .catch((e) => console.warn('[Deepthix][CoachPane] read state failed', e));
    void readProjectCoachMessages(projectId)
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
  }, [projectId]);

  // Persist messages whenever they change (debounced — bursty deltas
  // during streaming would otherwise hammer the disk). Skip the empty
  // initial render so we don't overwrite the persisted log with [] on
  // mount before the read above has populated state.
  const messagesPersistInitDoneRef = useRef(false);
  useEffect(() => {
    // First render with messages === [] (initial useState default) is
    // common — wait until either we've loaded existing messages OR
    // genuinely added a message.
    if (!messagesPersistInitDoneRef.current && messages.length === 0) return;
    messagesPersistInitDoneRef.current = true;
    const id = setTimeout(() => {
      void writeProjectCoachMessages(projectId, JSON.stringify(messages)).catch((e) =>
        console.warn('[Deepthix][CoachPane] write messages failed', e),
      );
    }, 500);
    return () => clearTimeout(id);
  }, [projectId, messages]);

  /** Persist state delta + update local. */
  const updateState = useCallback(
    async (patch: Partial<CoachState>): Promise<CoachState> => {
      const next = { ...state, ...patch };
      setState(next);
      try {
        await writeProjectCoachState(projectId, next);
      } catch (e) {
        console.warn('[Deepthix][CoachPane] write state failed', e);
      }
      return next;
    },
    [state, projectId],
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

  /** Spawn (or resume) the coach session for this project. */
  const spawnCoach = useCallback(async (): Promise<string | null> => {
    try {
      const r = await chatSpawn({
        cwd: cwdRef.current,
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
    }
  }, [state.coach_session_id]);

  /** Read excerpts from every claude session and feed the coach. */
  const runAnalysis = useCallback(async (): Promise<void> => {
    console.info('[Deepthix][CoachPane] runAnalysis: invoked', {
      busy: busyRef.current,
      sessions: sessionsRef.current.length,
      hasTerm: !!coachTermIdRef.current,
    });
    if (busyRef.current) {
      console.debug('[Deepthix][CoachPane] tick skipped — coach still busy');
      return;
    }
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
      // Surface this to the user — the placeholder otherwise sits at
      // "starting…" with no explanation.
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
    try {
      const blocks: string[] = [];
      for (const s of sessions) {
        const ex = await readSessionExcerpt(cwdRef.current, s.sessionId, EXCERPT_TURNS_PER_SESSION);
        if (!ex.trim()) continue;
        blocks.push(`### Session ${s.label} (${shortId(s.sessionId)})\n${ex}`);
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
      setBusy(true);
      busyRef.current = true;
      await chatSendUserText(term, prompt);
      void updateState({ last_run_ms: Date.now() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][CoachPane] runAnalysis failed', e);
      setError(msg);
      setBusy(false);
      busyRef.current = false;
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

  // 10-minute interval timer when enabled. Fires runAnalysis each
  // tick. Cleared cleanly on toggle-off / unmount / project switch.
  useEffect(() => {
    if (!state.enabled) return;
    const id = setInterval(() => {
      void runAnalysis();
    }, COACH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state.enabled, runAnalysis]);

  // Auto-spawn coach + kick off the first analysis on mount when the
  // user had the coach enabled before quitting (or just toggled it on
  // and we're racing the toggle handler). Without this, a freshly
  // reopened pane sat at "next analysis in 0m00s" forever — last_run_ms
  // was 0 so the countdown computed 0, but the 10-min interval doesn't
  // fire its first tick until 10 min from setup time.
  useEffect(() => {
    if (!state.enabled) return;
    if (coachTermIdRef.current) return;
    let cancelled = false;
    void (async () => {
      const term = await spawnCoach();
      if (cancelled || !term) return;
      const sinceLast = Date.now() - (state.last_run_ms || 0);
      if (sinceLast >= COACH_INTERVAL_MS) {
        console.info(
          '[Deepthix][CoachPane] mount: triggering first analysis (stale or never run)',
          { sinceLast, lastRunMs: state.last_run_ms },
        );
        void runAnalysis();
      } else {
        console.debug('[Deepthix][CoachPane] mount: skipping immediate run (recent)', {
          sinceLast,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.enabled, state.last_run_ms, spawnCoach, runAnalysis]);

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
          gap: 12,
          padding: '10px 14px',
          background: 'var(--color-bg-dark)',
          borderBottom: `2px solid ${state.enabled ? 'var(--color-accent)' : 'var(--color-border)'}`,
          fontSize: 12,
          transition: 'border-color 200ms ease',
        }}
      >
        <ToggleSwitch
          enabled={state.enabled}
          onChange={(next) => void setEnabled(next)}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div
            style={{
              fontWeight: 'bold',
              fontSize: 13,
              color: state.enabled ? 'var(--color-accent)' : 'var(--color-text)',
              letterSpacing: '0.04em',
              transition: 'color 200ms ease',
            }}
          >
            COACH · SONNET {state.enabled ? '·  ON' : '·  OFF'}
          </div>
          <div style={{ fontSize: 10, opacity: 0.65 }}>
            {state.enabled
              ? `Watching ${sessions.length} session${sessions.length === 1 ? '' : 's'} · next analysis in ${nextRunIn}`
              : 'Toggle ON to let it review your sessions every 10 min'}
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
                cwd={cwd}
                projectId={projectId}
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
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 32,
        opacity: 0.85,
      }}
    >
      <div style={{ fontSize: 14 }}>
        Coach (Sonnet) reviews EVERY claude session in this project every 10 min.
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, maxWidth: 420 }}>
        Toggle ON in the header. Suggestions can be appended to{' '}
        <code style={{ background: 'var(--color-bg-dark)', padding: '0 4px' }}>CLAUDE.md</code> with
        one click so the main sessions inherit them.
        {!hasSessions && (
          <>
            {' '}
            <strong>Open at least one claude session for this project first.</strong>
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

  // No structured cards → coach went off-format. Render as markdown
  // so we never lose information.
  if (proposals.length === 0 && schedules.length === 0) {
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

  const cardCount = proposals.length + schedules.length;
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
    </div>
  );
}

const ProposalCard = memo(_ProposalCard);
function _ProposalCard({
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

const ScheduleCard = memo(_ScheduleCard);
function _ScheduleCard({
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
