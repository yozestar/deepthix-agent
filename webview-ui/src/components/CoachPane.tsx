/* eslint-disable deepthix/no-inline-colors */
// Coach sub-session.
//
// Spawns a SEPARATE claude session (Sonnet by default — cheaper than
// the main session's Opus) whose only job is to look at what the
// main session is doing and suggest improvements. The user can:
//   - Pull the last N main-session messages → coach analyses them
//   - Paste their own question to the coach
//   - Click "Add to memory" on a coach reply → the suggestion is
//     appended to the project's CLAUDE.md so the main session has
//     it on next launch.
//
// Coach sessions live alongside the main session on disk
// (~/.claude/projects/<project>/<coach-uuid>.jsonl) and are tracked
// in localStorage by main-session-id so reopening a project picks
// the coach back up automatically.

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
  readSessionExcerpt,
} from '../tauri/commands';
import { onChatEvent, onChatExit } from '../tauri/events';

interface Props {
  /** cwd of the main session — coach is spawned in the same dir so
   *  it sees the project's CLAUDE.md, files, etc. */
  cwd: string;
  /** Stable UUID of the main session. Coach reads its JSONL by this id. */
  mainSessionId: string | null;
}

interface CoachMessage {
  uid: string;
  ts: number;
  role: 'user' | 'assistant';
  text: string;
  /** True when this assistant bubble is currently streaming. */
  streaming?: boolean;
}

const STORAGE_KEY_PREFIX = 'deepthix.coach.term.';
const DEFAULT_EXCERPT_TURNS = 20;
const COACH_PROMPT_PREFIX = `You are a coaching agent reviewing another claude session's recent activity. Be concise and actionable.

When you spot improvement opportunities, give a short bullet list. Each suggestion ≤ 2 sentences. End with a single \`SUMMARY\` line the user can copy into CLAUDE.md if they like it.

Session activity follows below.

---

`;

let nextUid = 1;
function uid(): string {
  return `c${nextUid++}`;
}

export function CoachPane({ cwd, mainSessionId }: Props): React.JSX.Element {
  const cacheKey = mainSessionId ? `${STORAGE_KEY_PREFIX}${mainSessionId}` : null;
  const [coachTermId, setCoachTermId] = useState<string | null>(() =>
    cacheKey ? localStorage.getItem(cacheKey) : null,
  );
  const [coachSessionId, setCoachSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const coachTermIdRef = useRef<string | null>(coachTermId);
  useEffect(() => {
    coachTermIdRef.current = coachTermId;
  }, [coachTermId]);
  const streamingMsgIdRef = useRef<string | null>(null);

  // Subscribe to chat_event lines for the coach term and translate
  // them into CoachMessage entries. Same parsing trick as ChatPane
  // but simpler (we don't render tool_use cards here — the coach is
  // expected to mostly produce plain text).
  useEffect(() => {
    if (!coachTermId) return;
    let unEvent: (() => void) | null = null;
    let unExit: (() => void) | null = null;
    let cancelled = false;
    const open: Record<string, string> = {}; // blockKey -> messageUid
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
          setCoachSessionId(sid);
          void chatSetSessionId(coachTermIdRef.current as string, sid).catch(() => {
            /* not fatal */
          });
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
          // Drop streaming flag on the most recent open block.
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
      setMessages((prev) => [
        ...prev,
        {
          uid: uid(),
          ts: Date.now(),
          role: 'assistant',
          text: `*coach exited (code ${evt.code ?? '?'}). Click "Restart coach" to spawn a new one.*`,
        },
      ]);
      // Clear the cache so the next render shows the spawn button.
      if (cacheKey) localStorage.removeItem(cacheKey);
      setCoachTermId(null);
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
  }, [coachTermId, cacheKey]);

  const startCoach = useCallback(async (): Promise<void> => {
    if (coachTermId) return;
    setError(null);
    try {
      const r = await chatSpawn({
        cwd,
        skip_permissions: true, // coach is read-only side-effect-free
        model: 'sonnet',
      });
      setCoachTermId(r.term_id);
      if (r.session_id) setCoachSessionId(r.session_id);
      if (cacheKey) localStorage.setItem(cacheKey, r.term_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][CoachPane] startCoach failed', e);
      setError(msg);
    }
  }, [coachTermId, cwd, cacheKey]);

  const stopCoach = useCallback(async (): Promise<void> => {
    if (!coachTermId) return;
    try {
      await chatKill(coachTermId);
    } catch (e) {
      console.warn('[Deepthix][CoachPane] kill failed', e);
    }
    if (cacheKey) localStorage.removeItem(cacheKey);
    setCoachTermId(null);
    setCoachSessionId(null);
    setMessages([]);
    setBusy(false);
  }, [coachTermId, cacheKey]);

  const interruptCoach = useCallback(() => {
    if (!coachTermId) return;
    void chatInterrupt(coachTermId).catch((e) =>
      console.warn('[Deepthix][CoachPane] interrupt failed', e),
    );
  }, [coachTermId]);

  const pullAndAnalyze = useCallback(
    async (lastN: number): Promise<void> => {
      if (!coachTermId || !mainSessionId) return;
      setPulling(true);
      setError(null);
      try {
        const excerpt = await readSessionExcerpt(cwd, mainSessionId, lastN);
        if (!excerpt.trim()) {
          setError('Main session has no recorded turns yet.');
          setPulling(false);
          return;
        }
        const userText = `${COACH_PROMPT_PREFIX}${excerpt}`;
        setMessages((prev) => [
          ...prev,
          {
            uid: uid(),
            ts: Date.now(),
            role: 'user',
            text: `📥 Pulled last ${lastN} turns of main session — analysing…`,
          },
        ]);
        setBusy(true);
        await chatSendUserText(coachTermId, userText);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][CoachPane] pullAndAnalyze failed', e);
        setError(msg);
        setBusy(false);
      } finally {
        setPulling(false);
      }
    },
    [coachTermId, cwd, mainSessionId],
  );

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

  const headerLabel = useMemo(() => {
    if (!coachTermId) return 'Coach (Sonnet) — not started';
    if (!coachSessionId) return 'Coach · spawning…';
    return `Coach · ${coachSessionId.slice(0, 8)}`;
  }, [coachTermId, coachSessionId]);

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
          gap: 8,
          padding: '4px 10px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
          fontSize: '11px',
          opacity: 0.9,
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{headerLabel}</span>
        {coachTermId && (
          <>
            <button
              type="button"
              onClick={() => void pullAndAnalyze(DEFAULT_EXCERPT_TURNS)}
              disabled={pulling || busy || !mainSessionId}
              title="Read the last N turns of the main session and ask the coach to analyse"
              style={pillButtonStyle(!pulling && !busy && Boolean(mainSessionId))}
            >
              {pulling ? '…' : `Analyse last ${DEFAULT_EXCERPT_TURNS}`}
            </button>
            {busy && (
              <button
                type="button"
                onClick={interruptCoach}
                title="Stop the current coach turn"
                style={{
                  ...pillButtonStyle(true),
                  background: 'var(--color-danger)',
                  color: 'var(--color-bg-dark)',
                }}
              >
                ⏹ Stop
              </button>
            )}
            <button
              type="button"
              onClick={() => void stopCoach()}
              title="Kill the coach session"
              style={pillButtonStyle(true)}
            >
              ✕
            </button>
          </>
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
        {!coachTermId ? (
          <EmptyCoach onStart={startCoach} hasMain={Boolean(mainSessionId)} />
        ) : messages.length === 0 ? (
          <div
            style={{
              opacity: 0.55,
              padding: '24px',
              textAlign: 'center',
              fontSize: '13px',
            }}
          >
            Coach is ready. Click <strong>Analyse last {DEFAULT_EXCERPT_TURNS}</strong> to feed it
            the recent main-session activity.
          </div>
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

function EmptyCoach({
  onStart,
  hasMain,
}: {
  onStart: () => void;
  hasMain: boolean;
}): React.JSX.Element {
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
        padding: '32px',
        opacity: 0.85,
      }}
    >
      <div style={{ fontSize: 40 }}>🧠</div>
      <div style={{ fontSize: 14 }}>
        Coach (Sonnet) reviews the main session in real time and proposes improvements.
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, maxWidth: 360 }}>
        Cheaper than the main model (Sonnet). Suggestions can be appended to{' '}
        <code style={{ background: 'var(--color-bg-dark)', padding: '0 4px' }}>CLAUDE.md</code> with
        one click so the main session has them on next launch.
      </div>
      <button
        type="button"
        onClick={onStart}
        disabled={!hasMain}
        title={hasMain ? '' : 'Open or send one message in the main session first'}
        style={{
          padding: '8px 18px',
          background: hasMain ? 'var(--color-accent)' : 'transparent',
          color: hasMain ? 'var(--color-bg-dark)' : 'inherit',
          border: '2px solid var(--color-border)',
          boxShadow: hasMain ? 'var(--shadow-pixel)' : 'none',
          cursor: hasMain ? 'pointer' : 'default',
          fontFamily: 'var(--font-pixel)',
          fontSize: 13,
          opacity: hasMain ? 1 : 0.5,
        }}
      >
        Start coach
      </button>
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
  const isUser = m.role === 'user';
  const justAdded = addingUid === m.uid;
  return (
    <div
      className="dt-chat-msg"
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '92%',
        background: isUser ? 'var(--color-accent)' : 'var(--color-bg-dark)',
        color: isUser ? 'var(--color-bg-dark)' : 'var(--color-text)',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        padding: '8px 10px',
        fontSize: 13,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
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
        <span>{isUser ? 'context' : 'coach'}</span>
        {!isUser && !m.streaming && m.text.trim().length > 20 && (
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
      {isUser ? (
        m.text
      ) : m.text.length === 0 && m.streaming ? (
        <span style={{ opacity: 0.5 }}>▌</span>
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
      )}
    </div>
  );
}

function pillButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: '2px 10px',
    background: enabled ? 'var(--color-bg)' : 'transparent',
    color: 'inherit',
    border: '1px solid var(--color-border)',
    fontFamily: 'var(--font-pixel)',
    fontSize: 11,
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.4,
  };
}
