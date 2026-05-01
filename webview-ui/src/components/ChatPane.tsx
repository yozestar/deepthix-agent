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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  chatKill,
  chatLoadHistory,
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
  /** Currently-streaming message id (set by message_start, cleared by
   *  message_stop). Used to attach content_block events to the right
   *  bubble. */
  activeMessageId: string | null;
  /** Set of (messageId|index) keys we've already created a bubble for.
   *  Lets us choose between "create new bubble" and "append to
   *  existing" when a content_block_delta arrives. */
  openBlocks: Set<string>;
  /** Set of message ids we've already streamed in full. Used to skip
   *  the consolidated `assistant` event that claude emits AFTER the
   *  stream_event chain — without this the user sees their message
   *  twice (once streamed, once duplicated). */
  streamedMessageIds: Set<string>;
}

function makeContext(): ParseContext {
  return {
    activeMessageId: null,
    openBlocks: new Set(),
    streamedMessageIds: new Set(),
  };
}

function blockKey(messageId: string, index: number): string {
  return `${messageId}|${index}`;
}

/**
 * Parse one line of a `~/.claude/projects/.../<session>.jsonl` file
 * into Message bubbles for the chat history.
 *
 * The on-disk JSONL format differs from the live stream-json wire
 * format: claude code writes its own internal record shape with
 * `parentUuid`, `attachment`, `userType`, `cwd`, `gitBranch`, etc.
 * We pull out the user/assistant content and ignore everything else
 * (queue-operation, attachment hooks, summary, system) so the
 * rendered history mirrors the chat the user typed and saw.
 */
function parseHistoryRecord(line: string): Message[] {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = r.type as string | undefined;
  const recordUuid = (r.uuid as string) ?? Math.random().toString(36);

  if (type === 'user') {
    const msg = r.message as Record<string, unknown> | undefined;
    if (!msg) return [];
    const content = msg.content;
    // Pure text input from the user: render as a user bubble. Tool
    // results sent back to claude are nested as content arrays — we
    // skip those (they'll show up under their tool_use card via the
    // separate `tool_result` block handling below).
    if (typeof content === 'string') {
      return [
        {
          kind: 'user',
          uid: recordUuid,
          ts: Date.parse((r.timestamp as string) ?? '') || Date.now(),
          text: content,
        },
      ];
    }
    if (Array.isArray(content)) {
      const out: Message[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text') {
          out.push({
            kind: 'user',
            uid: `${recordUuid}-${out.length}`,
            ts: Date.parse((r.timestamp as string) ?? '') || Date.now(),
            text: (block.text as string) ?? '',
          });
        } else if (block.type === 'tool_result') {
          out.push({
            kind: 'tool_use',
            uid: `${recordUuid}-${out.length}`,
            ts: Date.parse((r.timestamp as string) ?? '') || Date.now(),
            tool: '(result)',
            input: null,
            toolUseId: (block.tool_use_id as string) ?? '',
            result: {
              text: stringifyToolResult(block.content),
              isError: Boolean(block.is_error),
            },
          });
        }
      }
      return out;
    }
    return [];
  }

  if (type === 'assistant') {
    const msg = r.message as Record<string, unknown> | undefined;
    const messageId = (msg?.id as string) ?? recordUuid;
    const content = msg?.content;
    if (!Array.isArray(content)) return [];
    const out: Message[] = [];
    (content as Array<Record<string, unknown>>).forEach((block, idx) => {
      const key = blockKey(messageId, idx);
      if (block.type === 'text') {
        out.push({
          kind: 'assistant_text',
          uid: key,
          ts: Date.parse((r.timestamp as string) ?? '') || Date.now(),
          text: (block.text as string) ?? '',
          messageId: key,
        });
      } else if (block.type === 'tool_use') {
        out.push({
          kind: 'tool_use',
          uid: key,
          ts: Date.parse((r.timestamp as string) ?? '') || Date.now(),
          tool: (block.name as string) ?? '?',
          input: block.input,
          toolUseId: (block.id as string) ?? key,
        });
      }
    });
    return out;
  }

  // summary / system / attachment / queue-operation: not surfaced.
  return [];
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const block = b as Record<string, unknown>;
          if (block.type === 'text') return (block.text as string) ?? '';
          return JSON.stringify(block);
        }
        return String(b);
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

type ParseResult =
  | { append: Message[] }
  | { update: { blockKey: string; appendText: string } }
  | { setSession: string }
  | null;

function parseLine(line: string, ctx: ParseContext): ParseResult {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {
      append: [
        { kind: 'error', uid: uid(), ts: Date.now(), text: `(non-JSON line) ${line.slice(0, 200)}` },
      ],
    };
  }
  const type = obj.type as string | undefined;
  switch (type) {
    case 'system': {
      const subtype = (obj.subtype as string) ?? 'unknown';
      if (subtype === 'init') {
        const sid = obj.session_id as string | undefined;
        return sid ? { setSession: sid } : null;
      }
      // We already render `status: requesting` via the busy indicator;
      // suppress its noisy system bubble.
      if (subtype === 'status') return null;
      const summary =
        subtype === 'hook_started' || subtype === 'hook_response'
          ? `${subtype}: ${(obj.hook_name as string) ?? ''}`
          : subtype;
      return {
        append: [{ kind: 'system', uid: uid(), ts: Date.now(), subtype, summary }],
      };
    }
    case 'user':
      // claude echoes user messages back when --replay-user-messages is on.
      // We already created our own user bubble at send time, so skip.
      return null;
    case 'stream_event': {
      // Token-level streaming events emitted thanks to
      // --include-partial-messages. The shape:
      //   { type: 'stream_event', event: { type: 'message_start', ... } }
      //   { type: 'stream_event', event: { type: 'content_block_start', index, content_block: {type, ...} } }
      //   { type: 'stream_event', event: { type: 'content_block_delta', index, delta: {type, text|partial_json} } }
      //   { type: 'stream_event', event: { type: 'content_block_stop', index } }
      //   { type: 'stream_event', event: { type: 'message_stop' } }
      // We map each (messageId, index) pair to one bubble; deltas
      // append to it.
      const ev = obj.event as Record<string, unknown> | undefined;
      if (!ev) return null;
      const evType = ev.type as string | undefined;
      switch (evType) {
        case 'message_start': {
          const msg = ev.message as Record<string, unknown> | undefined;
          const id = (msg?.id as string) ?? null;
          ctx.activeMessageId = id;
          if (id) ctx.streamedMessageIds.add(id);
          return null;
        }
        case 'content_block_start': {
          const messageId = ctx.activeMessageId;
          if (!messageId) return null;
          const index = (ev.index as number) ?? 0;
          const cb = ev.content_block as Record<string, unknown> | undefined;
          const cbType = cb?.type as string | undefined;
          const key = blockKey(messageId, index);
          if (ctx.openBlocks.has(key)) return null;
          ctx.openBlocks.add(key);
          if (cbType === 'text') {
            return {
              append: [
                {
                  kind: 'assistant_text',
                  uid: key,
                  ts: Date.now(),
                  text: '',
                  messageId: key,
                },
              ],
            };
          }
          if (cbType === 'tool_use') {
            return {
              append: [
                {
                  kind: 'tool_use',
                  uid: key,
                  ts: Date.now(),
                  tool: (cb?.name as string) ?? '?',
                  input: cb?.input ?? null,
                  toolUseId: (cb?.id as string) ?? key,
                },
              ],
            };
          }
          return null;
        }
        case 'content_block_delta': {
          const messageId = ctx.activeMessageId;
          if (!messageId) return null;
          const index = (ev.index as number) ?? 0;
          const delta = ev.delta as Record<string, unknown> | undefined;
          const dType = delta?.type as string | undefined;
          if (dType === 'text_delta') {
            const text = (delta?.text as string) ?? '';
            if (!text) return null;
            return { update: { blockKey: blockKey(messageId, index), appendText: text } };
          }
          // input_json_delta for tool_use input streaming — ignored
          // for v1, the consolidated `assistant` event provides the
          // final input. We just don't dedup it (handled below).
          return null;
        }
        case 'message_stop': {
          ctx.activeMessageId = null;
          // openBlocks intentionally not cleared — they correspond to
          // bubbles in the visible log and we don't want to re-create
          // them if a stale event arrives late.
          return null;
        }
        default:
          return null;
      }
    }
    case 'assistant': {
      // Final consolidated assistant event. If we already streamed it
      // via stream_event blocks (always, when --include-partial-messages
      // is on), skip — otherwise we'd duplicate every bubble.
      const msg = obj.message as Record<string, unknown> | undefined;
      const messageId = (msg?.id as string) ?? null;
      if (messageId && ctx.streamedMessageIds.has(messageId)) return null;
      // Fallback path for runs without partial messages: emit the
      // consolidated content as one bubble per block (legacy behavior).
      const content = msg?.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) return null;
      const out: Message[] = [];
      content.forEach((block, idx) => {
        const key = messageId ? blockKey(messageId, idx) : uid();
        if (block.type === 'text') {
          out.push({
            kind: 'assistant_text',
            uid: key,
            ts: Date.now(),
            text: (block.text as string) ?? '',
            messageId: key,
          });
        } else if (block.type === 'tool_use') {
          out.push({
            kind: 'tool_use',
            uid: key,
            ts: Date.now(),
            tool: (block.name as string) ?? '?',
            input: block.input,
            toolUseId: (block.id as string) ?? key,
          });
        }
      });
      return out.length > 0 ? { append: out } : null;
    }
    case 'tool_result': {
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

  // Hydrate the message log from claude's own JSONL transcript on
  // mount when we're resuming a session. We don't depend on this for
  // claude itself — `--resume <id>` already gives the model its full
  // context — but the user expects to SEE the past conversation when
  // they reopen a session, not a blank pane.
  useEffect(() => {
    if (!resumeSessionId) return;
    let cancelled = false;
    void chatLoadHistory(cwd, resumeSessionId)
      .then((lines) => {
        if (cancelled) return;
        const restored: Message[] = [];
        for (const line of lines) {
          for (const m of parseHistoryRecord(line)) restored.push(m);
        }
        if (restored.length > 0) {
          setMessages((prev) => [...restored, ...prev]);
          console.info('[Deepthix][ChatPane] history loaded', {
            session: resumeSessionId,
            messages: restored.length,
            lines: lines.length,
          });
        }
      })
      .catch((e) => {
        console.warn('[Deepthix][ChatPane] history load failed', e);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, resumeSessionId]);

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
        const { blockKey, appendText } = parsed.update;
        setMessages((prev) =>
          prev.map((m) =>
            m.kind === 'assistant_text' && m.messageId === blockKey
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
      return (
        <Bubble
          align="right"
          bg="var(--color-accent)"
          fg="var(--color-bg-dark)"
          label="you"
          body={m.text}
          markdown={false}
        />
      );
    case 'assistant_text':
      return (
        <Bubble
          align="left"
          bg="var(--color-bg-dark)"
          fg="var(--color-text)"
          label="claude"
          body={m.text}
          markdown={true}
        />
      );
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
  markdown,
}: {
  align: 'left' | 'right';
  bg: string;
  fg: string;
  label: string;
  body: string;
  /** When true, render `body` as Markdown (assistant messages). User
   *  messages stay as plain text — they're already what the user typed. */
  markdown: boolean;
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
        // pre-wrap is the right default for plain text bubbles; the
        // markdown bubble below has its own block formatting and will
        // override per-element.
        whiteSpace: markdown ? 'normal' : 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      <div style={{ fontSize: '10px', opacity: 0.6, marginBottom: 4 }}>{label}</div>
      {markdown ? (
        // Empty body = the streaming bubble was just opened, no
        // tokens yet. Show a thin caret so the user knows something
        // is coming.
        body.length === 0 ? (
          <span style={{ opacity: 0.4 }}>▌</span>
        ) : (
          <MarkdownBody source={body} />
        )
      ) : (
        body
      )}
    </div>
  );
}

/**
 * react-markdown wrapper with custom code/inline-code styling.
 *
 * GitHub-flavored: tables, task lists, strikethrough via remark-gfm.
 * Code blocks get a dark background + monospace, inline code gets a
 * lighter chip with rounded corners. Default react-markdown classes
 * are reset by inline styles since we're inside a pixel-themed bubble
 * with no global Tailwind typography plugin.
 */
function MarkdownBody({ source }: { source: string }): React.JSX.Element {
  return (
    <div style={{ fontSize: '13px', lineHeight: 1.5 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p style={{ margin: '0 0 8px 0' }}>{children}</p>,
          ul: ({ children }) => (
            <ul style={{ margin: '0 0 8px 0', paddingLeft: 20 }}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol style={{ margin: '0 0 8px 0', paddingLeft: 20 }}>{children}</ol>
          ),
          li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
          h1: ({ children }) => (
            <h1 style={{ fontSize: '15px', fontWeight: 'bold', margin: '8px 0 4px' }}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 style={{ fontSize: '14px', fontWeight: 'bold', margin: '8px 0 4px' }}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ fontSize: '13px', fontWeight: 'bold', margin: '6px 0 3px' }}>{children}</h3>
          ),
          strong: ({ children }) => <strong style={{ fontWeight: 'bold' }}>{children}</strong>,
          em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}
            >
              {children}
            </a>
          ),
          code: ({ children, className }) => {
            // react-markdown@9 routes both inline and block code through
            // the `code` component. Block code is wrapped in a `pre`
            // by the default `pre` component below; inline code lands
            // here without any language className, so we differentiate
            // by `className` (block code has language-* set).
            const isBlock = typeof className === 'string' && className.startsWith('language-');
            if (isBlock) {
              return (
                <code
                  className={className}
                  style={{
                    fontFamily: 'Menlo, Consolas, monospace',
                    fontSize: '12px',
                    color: 'var(--color-text)',
                  }}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                style={{
                  fontFamily: 'Menlo, Consolas, monospace',
                  fontSize: '12px',
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  padding: '0 4px',
                  borderRadius: 0,
                }}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre
              style={{
                margin: '4px 0 8px',
                padding: '8px 10px',
                background: 'var(--color-bg)',
                border: '2px solid var(--color-border)',
                overflow: 'auto',
                fontFamily: 'Menlo, Consolas, monospace',
                fontSize: '12px',
                whiteSpace: 'pre',
                lineHeight: 1.4,
              }}
            >
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote
              style={{
                margin: '4px 0 8px',
                padding: '4px 10px',
                borderLeft: '3px solid var(--color-border)',
                opacity: 0.85,
              }}
            >
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div style={{ overflow: 'auto', margin: '4px 0 8px' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th
              style={{
                border: '1px solid var(--color-border)',
                padding: '4px 6px',
                textAlign: 'left',
                background: 'var(--color-bg)',
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              style={{
                border: '1px solid var(--color-border)',
                padding: '4px 6px',
              }}
            >
              {children}
            </td>
          ),
          hr: () => (
            <hr
              style={{
                border: 0,
                borderTop: '2px solid var(--color-border)',
                margin: '8px 0',
              }}
            />
          ),
        }}
      >
        {source}
      </ReactMarkdown>
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
