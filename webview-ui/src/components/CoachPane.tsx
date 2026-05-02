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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  appendToClaudeMd,
  chatInterrupt,
  chatKill,
  chatSendUserText,
  chatSetSessionId,
  chatSpawn,
  type CoachState,
  readProjectCoachState,
  readSessionExcerpt,
  writeProjectCoachState,
} from '../tauri/commands';
import { onChatEvent, onChatExit } from '../tauri/events';

const COACH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const EXCERPT_TURNS_PER_SESSION = 10;
const COACH_PROMPT_PREFIX = `You are a coaching agent watching multiple claude sessions in a project. Be terse and actionable.

For each session below, suggest at most 1-2 improvements (≤ 2 sentences each). Then end with a single \`SUMMARY\` block listing the top take-aways the user might want to copy into the project's CLAUDE.md.

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
  const [adding, setAdding] = useState<string | null>(null);
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

  // Load persisted state on project change.
  useEffect(() => {
    let cancelled = false;
    void readProjectCoachState(projectId)
      .then((s) => {
        if (cancelled) return;
        setState(s);
      })
      .catch((e) => console.warn('[Deepthix][CoachPane] read state failed', e));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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
    if (busyRef.current) {
      console.debug('[Deepthix][CoachPane] tick skipped — coach still busy');
      return;
    }
    let term = coachTermIdRef.current;
    if (!term) {
      term = await spawnCoach();
      if (!term) return;
    }
    const sessions = sessionsRef.current;
    if (sessions.length === 0) {
      console.debug('[Deepthix][CoachPane] tick skipped — no sessions in project');
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

  // Auto-spawn coach on mount if it should be enabled but isn't yet
  // (e.g. fresh app launch, user had it on before quitting).
  useEffect(() => {
    if (!state.enabled) return;
    if (coachTermIdRef.current) return;
    void spawnCoach();
  }, [state.enabled, spawnCoach]);

  const interrupt = useCallback(() => {
    if (!coachTermId) return;
    void chatInterrupt(coachTermId).catch((e) =>
      console.warn('[Deepthix][CoachPane] interrupt failed', e),
    );
  }, [coachTermId]);

  const addToMemory = useCallback(
    async (m: CoachMessage): Promise<void> => {
      setAdding(m.uid);
      try {
        await appendToClaudeMd(cwd, m.text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][CoachPane] addToMemory failed', e);
        setError(msg);
      } finally {
        setTimeout(() => setAdding(null), 1500);
      }
    },
    [cwd],
  );

  // Auto-scroll on new content.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const nextRunIn = useMemo(() => {
    if (!state.enabled) return null;
    const since = Date.now() - (state.last_run_ms || 0);
    const remaining = Math.max(0, COACH_INTERVAL_MS - since);
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
          gap: 10,
          padding: '6px 12px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
          fontSize: 12,
        }}
      >
        <ToggleSwitch
          enabled={state.enabled}
          onChange={(next) => void setEnabled(next)}
        />
        <span style={{ flex: 1 }}>
          Coach (Sonnet) {state.enabled ? 'ON' : 'OFF'}
          {state.enabled && (
            <span style={{ opacity: 0.6, marginLeft: 8 }}>
              · analysing every 10 min · next in {nextRunIn}
            </span>
          )}
        </span>
        {busy && (
          <button
            type="button"
            onClick={interrupt}
            title="Stop the running analysis"
            style={{
              padding: '2px 10px',
              background: 'var(--color-danger)',
              color: 'var(--color-bg-dark)',
              border: '1px solid var(--color-border)',
              fontFamily: 'var(--font-pixel)',
              fontSize: 11,
              cursor: 'pointer',
            }}
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
        ) : (
          messages.map((m) => (
            <CoachBubble
              key={m.uid}
              m={m}
              onAdd={() => void addToMemory(m)}
              addingUid={adding}
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
        width: 38,
        height: 18,
        background: enabled ? 'var(--color-accent)' : 'transparent',
        border: '2px solid var(--color-border)',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 1,
          left: enabled ? 19 : 1,
          width: 12,
          height: 12,
          background: enabled ? 'var(--color-bg-dark)' : 'var(--color-text)',
          transition: 'left 120ms ease',
        }}
      />
    </button>
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

function CoachBubble({
  m,
  onAdd,
  addingUid,
}: {
  m: CoachMessage;
  onAdd: () => void;
  addingUid: string | null;
}): React.JSX.Element {
  const justAdded = addingUid === m.uid;
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 10,
          opacity: 0.6,
          marginBottom: 4,
        }}
      >
        <span>coach · {new Date(m.ts).toLocaleTimeString()}</span>
        {!m.streaming && m.text.trim().length > 20 && (
          <button
            type="button"
            onClick={onAdd}
            title="Append this suggestion to the project's CLAUDE.md"
            style={{
              background: justAdded ? 'var(--color-success, #34d399)' : 'transparent',
              color: justAdded ? 'var(--color-bg-dark)' : 'inherit',
              border: '1px solid var(--color-border)',
              padding: '1px 6px',
              fontFamily: 'var(--font-pixel)',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            {justAdded ? '✓ added' : '+ memory'}
          </button>
        )}
      </div>
      {m.text.length === 0 && m.streaming ? (
        <span style={{ opacity: 0.5 }}>▌</span>
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
      )}
    </div>
  );
}
