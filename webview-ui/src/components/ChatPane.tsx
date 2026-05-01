/* eslint-disable deepthix/no-inline-colors */
// ChatPane — replaces TerminalTab for claude sessions.
//
// Backed by `chat_spawn` which runs `claude --print --output-format
// stream-json --input-format stream-json --verbose`. Each newline-
// delimited JSON event from claude's stdout becomes a `chat_event`
// Tauri event; we accumulate them into a typed message log and render
// the conversation as a chat UI (no xterm, no Ink, no terminal cell
// drift).
//
// Inputs the user sends (text in the bottom box, voice transcripts,
// drag-dropped paths) become `chat_send_user_text` calls — claude
// reads a `{"type":"user","message":{...}}` line on stdin and produces
// the matching response.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  chatKill,
  chatSendUserText,
  chatSetSessionId,
  chatSpawn,
} from '../tauri/commands';
import { onChatEvent, onChatExit } from '../tauri/events';

interface Props {
  /** Stable working dir for the spawn — usually the project's path. */
  cwd: string;
  /** When non-null we resume an existing claude session by UUID. */
  resumeSessionId?: string | null;
  /** Forwarded as `--dangerously-skip-permissions`. */
  skipPermissions?: boolean;
  /** Optional pre-existing term_id to bind to (skips spawn — used for
   *  reconnecting to a session that was spawned by a parent component). */
  bindTermId?: string | null;
  /** Fires once spawn resolves (so the parent can persist the new
   *  session_id once we learn it from the system/init line). */
  onSessionReady?: (info: { termId: string; sessionId: string | null }) => void;
}

// ─── Message model ──────────────────────────────────────────────────────

type Message =
  | { kind: 'user'; uid: string; ts: number; text: string }
  | {
      kind: 'assistant_text';
      uid: string;
      ts: number;
      text: string;
      messageId: string | null;
    }
  | {
      kind: 'tool_use';
      uid: string;
      ts: number;
      tool: string;
      input: unknown;
      toolUseId: string;
      result?: { text: string; isError: boolean };
    }
  | { kind: 'system'; uid: string; ts: number; subtype: string; summary: string }
  | {
      kind: 'result';
      uid: string;
      ts: number;
      ok: boolean;
      durationMs: number;
      costUsd: number;
      text: string;
    }
  | { kind: 'error'; uid: string; ts: number; text: string };

let nextUid = 1;
function uid(): string {
  return `m${nextUid++}`;
}

// ─── Stream parser ──────────────────────────────────────────────────────

interface ParseContext {
  /** Buffer per-message-id so streaming text deltas concat into one
   *  message instead of producing one bubble per token. */
  assistantByMsgId: Map<string, string>;
}

function makeContext(): ParseContext {
  return { assistantByMsgId: new Map() };
}

function parseLine(
  line: string,
  ctx: ParseContext,
):
  | { append: Message[] }
  | { update: { messageId: string; appendText: string } }
  | { setSession: string }
  | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { append: [{ kind: 'error', uid: uid(), ts: Date.now(), text: `(non-JSON line) ${line.slice(0, 200)}` }] };
  }
  const type = obj.type as string | undefined;
  switch (type) {
    case 'system': {
      const subtype = (obj.subtype as string) ?? 'unknown';
      if (subtype === 'init') {
        const sid = obj.session_id as string | undefined;
        return sid ? { setSession: sid } : null;
      }
      const summary = subtype === 'hook_started' || subtype === 'hook_response'
        ? `${subtype}: ${(obj.hook_name as string) ?? ''}`
        : subtype;
      return {
        append: [{ kind: 'system', uid: uid(), ts: Date.now(), subtype, summary }],
      };
    }
    case 'user': {
      // claude echoes user messages back when --replay-user-messages is on.
      // We already created our own user bubble at send time, so skip.
      return null;
    }
    case 'assistant': {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (!msg) return null;
      const messageId = (msg.id as string) ?? uid();
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) return null;
      const out: Message[] = [];
      for (const block of content) {
        if (block.type === 'text') {
          const text = (block.text as string) ?? '';
          // Dedupe-by-messageId: if we already have a message bubble
          // with this id, append to it instead of creating a new one.
          if (ctx.assistantByMsgId.has(messageId)) {
            const prev = ctx.assistantByMsgId.get(messageId) ?? '';
            ctx.assistantByMsgId.set(messageId, prev + text);
            return { update: { messageId, appendText: text } };
          }
          ctx.assistantByMsgId.set(messageId, text);
          out.push({
            kind: 'assistant_text',
            uid: uid(),
            ts: Date.now(),
            text,
            messageId,
          });
        } else if (block.type === 'tool_use') {
          out.push({
            kind: 'tool_use',
            uid: uid(),
            ts: Date.now(),
            tool: (block.name as string) ?? '?',
            input: block.input,
            toolUseId: (block.id as string) ?? uid(),
          });
        }
      }
      return out.length > 0 ? { append: out } : null;
    }
    case 'tool_result': {
      // Some claude versions emit tool_result as its own top-level
      // event; others fold it into a user message with content
      // [{type:"tool_result"...}]. We accept both shapes.
      const toolUseId = (obj.tool_use_id as string) ?? '';
      const resultText = String(obj.content ?? '');
      const isError = Boolean(obj.is_error);
      return {
        append: [
          {
            kind: 'tool_use',
            uid: uid(),
            ts: Date.now(),
            tool: '(result)',
            input: null,
            toolUseId,
            result: { text: resultText, isError },
          },
        ],
      };
    }
    case 'result': {
      const subtype = (obj.subtype as string) ?? '';
      const ok = subtype === 'success';
      return {
        append: [
          {
            kind: 'result',
            uid: uid(),
            ts: Date.now(),
            ok,
            durationMs: (obj.duration_ms as number) ?? 0,
            costUsd: (obj.total_cost_usd as number) ?? 0,
            text: (obj.result as string) ?? subtype,
          },
        ],
      };
    }
    case 'rate_limit_event':
      // Rendered as a small system note.
      return {
        append: [
          {
            kind: 'system',
            uid: uid(),
            ts: Date.now(),
            subtype: 'rate_limit',
            summary: `rate limit ${
              ((obj.rate_limit_info as Record<string, unknown> | undefined)?.status as string) ?? '?'
            }`,
          },
        ],
      };
    default:
      return null;
  }
}

// ─── Component ──────────────────────────────────────────────────────────

export function ChatPane({
  cwd,
  resumeSessionId,
  skipPermissions,
  bindTermId,
  onSessionReady,
}: Props): React.JSX.Element {
  const [termId, setTermId] = useState<string | null>(bindTermId ?? null);
  const [sessionId, setSessionId] = useState<string | null>(resumeSessionId ?? null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctxRef = useRef<ParseContext>(makeContext());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const termIdRef = useRef<string | null>(termId);
  useEffect(() => {
    termIdRef.current = termId;
  }, [termId]);

  // Spawn on mount (unless we were handed a pre-existing termId).
  useEffect(() => {
    if (bindTermId) return;
    let cancelled = false;
    void chatSpawn({
      cwd,
      resume_session_id: resumeSessionId ?? null,
      skip_permissions: skipPermissions ?? false,
    })
      .then((res) => {
        if (cancelled) {
          void chatKill(res.term_id);
          return;
        }
        setTermId(res.term_id);
        if (res.session_id) setSessionId(res.session_id);
        onSessionReady?.({ termId: res.term_id, sessionId: res.session_id });
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][ChatPane] spawn failed', e);
        setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, resumeSessionId, skipPermissions, bindTermId, onSessionReady]);

  // Subscribe to events for THIS termId.
  useEffect(() => {
    if (!termId) return;
    let unEvent: (() => void) | null = null;
    let unExit: (() => void) | null = null;
    let cancelled = false;
    void onChatEvent((evt) => {
      if (evt.term_id !== termIdRef.current) return;
      if (evt.stream === 'stderr') {
        // Surface stderr as a grey system note — they're usually
        // informational (rate-limit retries, hook warnings).
        setMessages((prev) => [
          ...prev,
          {
            kind: 'system',
            uid: uid(),
            ts: Date.now(),
            subtype: 'stderr',
            summary: evt.line.slice(0, 240),
          },
        ]);
        return;
      }
      const parsed = parseLine(evt.line, ctxRef.current);
      if (!parsed) return;
      if ('setSession' in parsed) {
        const sid = parsed.setSession;
        setSessionId(sid);
        // Tell the Rust ChatManager so the scheduler can resolve
        // session_id → term_id when firing scheduled jobs.
        const tid = termIdRef.current as string;
        void chatSetSessionId(tid, sid).catch((e) =>
          console.warn('[Deepthix][ChatPane] chat_set_session_id failed', e),
        );
        onSessionReady?.({ termId: tid, sessionId: sid });
      } else if ('append' in parsed) {
        setMessages((prev) => [...prev, ...parsed.append]);
        if (parsed.append.some((m) => m.kind === 'result')) setBusy(false);
      } else if ('update' in parsed) {
        const { messageId, appendText } = parsed.update;
        setMessages((prev) =>
          prev.map((m) =>
            m.kind === 'assistant_text' && m.messageId === messageId
              ? { ...m, text: m.text + appendText }
              : m,
          ),
        );
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unEvent = fn;
        }
      })
      .catch((e) => console.error('[Deepthix][ChatPane] subscribe chat_event', e));
    void onChatExit((evt) => {
      if (evt.term_id !== termIdRef.current) return;
      setMessages((prev) => [
        ...prev,
        {
          kind: 'system',
          uid: uid(),
          ts: Date.now(),
          subtype: 'exit',
          summary: `claude exited (code ${evt.code ?? '?'})`,
        },
      ]);
      setBusy(false);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unExit = fn;
        }
      })
      .catch((e) => console.error('[Deepthix][ChatPane] subscribe chat_exit', e));
    return () => {
      cancelled = true;
      if (unEvent) unEvent();
      if (unExit) unExit();
    };
  }, [termId, onSessionReady]);

  // Auto-scroll to the bottom when new messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (!text || !termId) return;
    setInput('');
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { kind: 'user', uid: uid(), ts: Date.now(), text },
    ]);
    try {
      await chatSendUserText(termId, text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][ChatPane] send failed', e);
      setError(msg);
      setBusy(false);
    }
  }, [input, termId]);

  const headerLabel = useMemo(
    () => (sessionId ? `claude · ${sessionId.slice(0, 8)}` : 'claude · starting…'),
    [sessionId],
  );

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
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 10px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
          fontSize: '11px',
          opacity: 0.85,
        }}
      >
        <span title={cwd}>{headerLabel}</span>
        <span>{busy ? 'thinking…' : 'idle'}</span>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        {error && (
          <div
            style={{
              padding: '8px 10px',
              background: 'var(--color-danger)',
              color: 'var(--color-bg-dark)',
              fontSize: '12px',
              border: '2px solid var(--color-border)',
            }}
          >
            {error}
          </div>
        )}
        {messages.length === 0 && !error && (
          <div style={{ opacity: 0.55, padding: '24px', textAlign: 'center', fontSize: '13px' }}>
            Type a message and hit ⏎ to start.
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.uid} m={m} />
        ))}
      </div>

      {/* Input row */}
      <div
        style={{
          padding: '8px',
          background: 'var(--color-bg-dark)',
          borderTop: '2px solid var(--color-border)',
          display: 'flex',
          gap: 8,
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={termId ? 'Message claude (⏎ send, ⇧⏎ newline)' : 'Spawning claude…'}
          disabled={!termId || busy}
          rows={3}
          style={{
            flex: 1,
            resize: 'none',
            padding: '8px',
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
            border: '2px solid var(--color-border)',
            outline: 'none',
            fontFamily: 'var(--font-pixel)',
            fontSize: '13px',
            lineHeight: 1.4,
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!termId || busy || !input.trim()}
          style={{
            padding: '4px 16px',
            background:
              termId && !busy && input.trim() ? 'var(--color-accent)' : 'transparent',
            color:
              termId && !busy && input.trim() ? 'var(--color-bg-dark)' : 'inherit',
            border: '2px solid var(--color-border)',
            boxShadow: termId && !busy && input.trim() ? 'var(--shadow-pixel)' : 'none',
            cursor: termId && !busy && input.trim() ? 'pointer' : 'default',
            fontFamily: 'var(--font-pixel)',
            fontSize: '13px',
            opacity: termId && !busy && input.trim() ? 1 : 0.4,
          }}
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

// ─── Message bubbles ────────────────────────────────────────────────────

function MessageBubble({ m }: { m: Message }): React.JSX.Element {
  switch (m.kind) {
    case 'user':
      return <Bubble align="right" bg="var(--color-accent)" fg="var(--color-bg-dark)" label="you" body={m.text} />;
    case 'assistant_text':
      return <Bubble align="left" bg="var(--color-bg-dark)" fg="var(--color-text)" label="claude" body={m.text} />;
    case 'tool_use':
      return <ToolBubble m={m} />;
    case 'system':
      return (
        <div
          style={{
            alignSelf: 'center',
            fontSize: '11px',
            opacity: 0.6,
            padding: '2px 8px',
            border: '1px dashed var(--color-border)',
          }}
        >
          {m.summary}
        </div>
      );
    case 'result':
      return (
        <div
          style={{
            alignSelf: 'center',
            fontSize: '11px',
            opacity: 0.7,
            padding: '4px 10px',
            border: '2px solid var(--color-border)',
            background: m.ok ? 'var(--color-bg-dark)' : 'var(--color-danger)',
            color: m.ok ? 'inherit' : 'var(--color-bg-dark)',
          }}
        >
          turn ended · {(m.durationMs / 1000).toFixed(1)}s · ${m.costUsd.toFixed(4)}
        </div>
      );
    case 'error':
      return (
        <div
          style={{
            alignSelf: 'stretch',
            fontSize: '12px',
            padding: '6px 10px',
            background: 'var(--color-danger)',
            color: 'var(--color-bg-dark)',
            border: '2px solid var(--color-border)',
          }}
        >
          {m.text}
        </div>
      );
  }
}

function Bubble({
  align,
  bg,
  fg,
  label,
  body,
}: {
  align: 'left' | 'right';
  bg: string;
  fg: string;
  label: string;
  body: string;
}): React.JSX.Element {
  return (
    <div
      style={{
        alignSelf: align === 'right' ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        background: bg,
        color: fg,
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        padding: '8px 10px',
        fontSize: '13px',
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      <div style={{ fontSize: '10px', opacity: 0.6, marginBottom: 4 }}>{label}</div>
      {body}
    </div>
  );
}

function ToolBubble({
  m,
}: {
  m: Extract<Message, { kind: 'tool_use' }>;
}): React.JSX.Element {
  const inputPreview = useMemo(() => {
    try {
      return JSON.stringify(m.input, null, 2).slice(0, 600);
    } catch {
      return String(m.input).slice(0, 600);
    }
  }, [m.input]);
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '92%',
        background: 'var(--color-bg-dark)',
        border: '2px dashed var(--color-border)',
        padding: '6px 10px',
        fontSize: '12px',
        fontFamily: 'Menlo, Consolas, monospace',
      }}
    >
      <div style={{ fontWeight: 'bold', marginBottom: 4, opacity: 0.85 }}>
        🛠 {m.tool}
      </div>
      {m.input != null && inputPreview && (
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.85 }}>
          {inputPreview}
        </pre>
      )}
      {m.result && (
        <div
          style={{
            marginTop: 4,
            padding: '4px 6px',
            background: m.result.isError ? 'var(--color-danger)' : 'var(--color-bg)',
            color: m.result.isError ? 'var(--color-bg-dark)' : 'inherit',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 200,
            overflow: 'auto',
          }}
        >
          {m.result.text.slice(0, 4000)}
        </div>
      )}
    </div>
  );
}
