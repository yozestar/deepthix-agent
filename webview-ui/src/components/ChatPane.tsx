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
  chatInterrupt,
  chatKill,
  chatLoadHistory,
  chatSendUserText,
  chatSetSessionId,
  chatSpawn,
  openExternalUrl,
  readClaudeDailyActivity,
  readClaudeSubscription,
  readClaudeUsageLimits,
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

type ParseAction =
  | { kind: 'append'; messages: Message[] }
  | { kind: 'append_text'; blockKey: string; text: string }
  /** Patch the input of an existing tool_use bubble. Indexed by
   *  `toolUseId` (toolu_xxx) instead of blockKey because the
   *  consolidated `assistant` event with --include-partial-messages
   *  fires once per block with `content` length 1 and index 0,
   *  losing the original block index — but the toolUseId is stable. */
  | { kind: 'set_tool_input'; toolUseId: string; input: unknown }
  | { kind: 'set_session'; sessionId: string }
  | { kind: 'set_slash_commands'; commands: string[] }
  | { kind: 'turn_end'; ok: boolean; durationMs: number; costUsd: number };

type ParseResult = ParseAction[];

function parseLine(line: string, ctx: ParseContext): ParseResult {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [
      {
        kind: 'append',
        messages: [
          { kind: 'error', uid: uid(), ts: Date.now(), text: `(non-JSON line) ${line.slice(0, 200)}` },
        ],
      },
    ];
  }
  const type = obj.type as string | undefined;
  switch (type) {
    case 'system': {
      const subtype = (obj.subtype as string) ?? 'unknown';
      if (subtype === 'init') {
        const sid = obj.session_id as string | undefined;
        const slash =
          (obj.slash_commands as string[] | undefined)?.filter(
            (s) => typeof s === 'string',
          ) ?? null;
        const actions: ParseAction[] = [];
        if (sid) actions.push({ kind: 'set_session', sessionId: sid });
        if (slash && slash.length > 0)
          actions.push({ kind: 'set_slash_commands', commands: slash });
        return actions;
      }
      // Suppress all of these — they show up on every turn and just
      // chrome-bloat the chat:
      //   - status: rendered as the header "thinking…" indicator
      //   - hook_started / hook_response: per-session-start noise from
      //     plugins (superpowers, etc.). Errors still come through
      //     stderr.
      //   - any subtype we don't explicitly recognise stays hidden.
      return [];
    }
    case 'user':
      // We already created our own user bubble at send time.
      return [];
    case 'stream_event': {
      const ev = obj.event as Record<string, unknown> | undefined;
      if (!ev) return [];
      const evType = ev.type as string | undefined;
      switch (evType) {
        case 'message_start': {
          const msg = ev.message as Record<string, unknown> | undefined;
          const id = (msg?.id as string) ?? null;
          ctx.activeMessageId = id;
          if (id) ctx.streamedMessageIds.add(id);
          return [];
        }
        case 'content_block_start': {
          const messageId = ctx.activeMessageId;
          if (!messageId) return [];
          const index = (ev.index as number) ?? 0;
          const cb = ev.content_block as Record<string, unknown> | undefined;
          const cbType = cb?.type as string | undefined;
          const key = blockKey(messageId, index);
          if (ctx.openBlocks.has(key)) return [];
          ctx.openBlocks.add(key);
          if (cbType === 'text') {
            return [
              {
                kind: 'append',
                messages: [
                  {
                    kind: 'assistant_text',
                    uid: key,
                    ts: Date.now(),
                    text: '',
                    messageId: key,
                  },
                ],
              },
            ];
          }
          if (cbType === 'tool_use') {
            return [
              {
                kind: 'append',
                messages: [
                  {
                    kind: 'tool_use',
                    uid: key,
                    ts: Date.now(),
                    tool: (cb?.name as string) ?? '?',
                    // input arrives in input_json_delta chunks AFTER
                    // this start event; the consolidated `assistant`
                    // event below patches it in once everything's
                    // accumulated.
                    input: cb?.input ?? null,
                    toolUseId: (cb?.id as string) ?? key,
                  },
                ],
              },
            ];
          }
          return [];
        }
        case 'content_block_delta': {
          const messageId = ctx.activeMessageId;
          if (!messageId) return [];
          const index = (ev.index as number) ?? 0;
          const delta = ev.delta as Record<string, unknown> | undefined;
          const dType = delta?.type as string | undefined;
          if (dType === 'text_delta') {
            const text = (delta?.text as string) ?? '';
            if (!text) return [];
            return [{ kind: 'append_text', blockKey: blockKey(messageId, index), text }];
          }
          // input_json_delta accumulates into the tool_use input. We
          // ignore the partial chunks and let the consolidated
          // `assistant` event below patch the final input — saves a
          // bunch of partial-JSON-parse complexity.
          return [];
        }
        case 'message_stop': {
          ctx.activeMessageId = null;
          return [];
        }
        default:
          return [];
      }
    }
    case 'assistant': {
      // Final consolidated assistant event arrives AFTER message_stop.
      // - Text blocks: skip (we already streamed them via text_delta).
      // - tool_use blocks: PATCH the corresponding bubble's input
      //   field with the final accumulated input. The bubble created
      //   at content_block_start had input=null/{}; this is where we
      //   fill it in.
      const msg = obj.message as Record<string, unknown> | undefined;
      const messageId = (msg?.id as string) ?? null;
      const content = msg?.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) return [];
      const wasStreamed = messageId ? ctx.streamedMessageIds.has(messageId) : false;
      const actions: ParseAction[] = [];
      content.forEach((block, idx) => {
        const key = messageId ? blockKey(messageId, idx) : uid();
        if (block.type === 'text') {
          if (!wasStreamed) {
            // Fallback path for runs without --include-partial-messages.
            actions.push({
              kind: 'append',
              messages: [
                {
                  kind: 'assistant_text',
                  uid: key,
                  ts: Date.now(),
                  text: (block.text as string) ?? '',
                  messageId: key,
                },
              ],
            });
          }
        } else if (block.type === 'tool_use') {
          if (wasStreamed) {
            // Bubble already exists — patch in the now-complete input
            // by toolUseId (the block's positional `idx` here is 0
            // because each consolidated event with --include-partial-
            // messages carries only one block, so it can't tell us the
            // bubble's real index in the streamed message).
            actions.push({
              kind: 'set_tool_input',
              toolUseId: (block.id as string) ?? '',
              input: block.input,
            });
          } else {
            actions.push({
              kind: 'append',
              messages: [
                {
                  kind: 'tool_use',
                  uid: key,
                  ts: Date.now(),
                  tool: (block.name as string) ?? '?',
                  input: block.input,
                  toolUseId: (block.id as string) ?? key,
                },
              ],
            });
          }
        }
      });
      return actions;
    }
    case 'tool_result': {
      const toolUseId = (obj.tool_use_id as string) ?? '';
      const resultText = String(obj.content ?? '');
      const isError = Boolean(obj.is_error);
      return [
        {
          kind: 'append',
          messages: [
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
        },
      ];
    }
    case 'result': {
      const subtype = (obj.subtype as string) ?? '';
      return [
        {
          kind: 'turn_end',
          ok: subtype === 'success',
          durationMs: (obj.duration_ms as number) ?? 0,
          costUsd: (obj.total_cost_usd as number) ?? 0,
        },
      ];
    }
    case 'rate_limit_event': {
      // Only surface rate-limit when we're actually being throttled —
      // "allowed" status fires on every turn and is just noise.
      const info = obj.rate_limit_info as Record<string, unknown> | undefined;
      const status = (info?.status as string) ?? 'allowed';
      if (status === 'allowed') return [];
      return [
        {
          kind: 'append',
          messages: [
            {
              kind: 'system',
              uid: uid(),
              ts: Date.now(),
              subtype: 'rate_limit',
              summary: `rate limit ${status}`,
            },
          ],
        },
      ];
    }
    default:
      return [];
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
  /** Slash commands learned from the system/init event. Used to drive
   *  the autocomplete popup when the user types `/` at the start of
   *  the input. */
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  /** Last turn summary for the header. Replaces the per-turn bubble. */
  const [lastTurn, setLastTurn] = useState<
    { ok: boolean; durationMs: number; costUsd: number } | null
  >(null);
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
      const actions = parseLine(evt.line, ctxRef.current);
      for (const a of actions) {
        switch (a.kind) {
          case 'set_session': {
            setSessionId(a.sessionId);
            const tid = termIdRef.current as string;
            void chatSetSessionId(tid, a.sessionId).catch((e) =>
              console.warn('[Deepthix][ChatPane] chat_set_session_id failed', e),
            );
            onSessionReady?.({ termId: tid, sessionId: a.sessionId });
            break;
          }
          case 'append': {
            setMessages((prev) => [...prev, ...a.messages]);
            break;
          }
          case 'turn_end': {
            setLastTurn({
              ok: a.ok,
              durationMs: a.durationMs,
              costUsd: a.costUsd,
            });
            setBusy(false);
            break;
          }
          case 'set_slash_commands': {
            setSlashCommands(a.commands);
            break;
          }
          case 'append_text': {
            setMessages((prev) =>
              prev.map((m) =>
                m.kind === 'assistant_text' && m.messageId === a.blockKey
                  ? { ...m, text: m.text + a.text }
                  : m,
              ),
            );
            break;
          }
          case 'set_tool_input': {
            // The bubble created at content_block_start had input {}
            // because input arrives in input_json_delta chunks we
            // ignore. The per-block `assistant` event (one per block
            // with --include-partial-messages) hands us the final
            // accumulated input. Match by toolUseId — positional
            // indexes don't survive the per-block fragmentation.
            setMessages((prev) =>
              prev.map((m) =>
                m.kind === 'tool_use' && m.toolUseId === a.toolUseId
                  ? { ...m, input: a.input }
                  : m,
              ),
            );
            break;
          }
        }
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

  /**
   * Slash commands handled CLIENT-SIDE — never sent to claude.
   *
   * Why: in `--print --input-format stream-json` mode there's no TUI
   * to intercept slash commands. They reach the model verbatim and
   * claude code wraps them in <command-name> XML before forwarding,
   * which is useless noise (visible bug from user feedback). The
   * actual command (e.g. `/usage`) only does anything in the
   * interactive TUI.
   *
   * So we maintain a small whitelist of commands we implement
   * ourselves and intercept them in `send`. Anything else with a `/`
   * prefix gets a friendly system message explaining it isn't
   * available — better than silently shipping XML to claude.
   */
  const handleSlashCommand = useCallback(
    (cmdLine: string): boolean => {
      const cmd = cmdLine.split(/\s+/)[0].toLowerCase().replace(/^\//, '');
      const dropMessage = (text: string): void => {
        setMessages((prev) => [
          ...prev,
          { kind: 'system', uid: uid(), ts: Date.now(), subtype: 'slash', summary: text },
        ]);
      };
      switch (cmd) {
        case 'help':
          dropMessage(
            [
              'Commands available in chat:',
              '  /usage — current plan + today\'s msg/sess + window utilisation',
              '  /cost — duration + cost of the last turn',
              '  /clear — reset the local view (on-disk context preserved)',
              '  /agents — open claude.ai/agents in your browser',
              '  /privacy — open Anthropic privacy in your browser',
              '  /upgrade — open the upgrade page in your browser',
              '  /help — this list',
              '',
              'Shortcuts: ⏎ send · ⇧⏎ newline · ↑/↓ history · / autocomplete · ⌘M push-to-talk',
            ].join('\n'),
          );
          return true;
        case 'cost':
          if (lastTurn) {
            dropMessage(
              `Last turn: ${(lastTurn.durationMs / 1000).toFixed(1)}s · $${lastTurn.costUsd.toFixed(4)}`,
            );
          } else {
            dropMessage('No turn yet — send a message to see its cost.');
          }
          return true;
        case 'clear':
          // Clear local message log only. Claude's actual context is
          // still on disk (the JSONL); the next message will reference
          // it via --resume.
          setMessages([]);
          ctxRef.current = makeContext();
          dropMessage('Local view cleared. Conversation context preserved on disk.');
          return true;
        case 'usage': {
          // Pull every usage source we have and render a summary
          // bubble. Same data the sidebar's USAGE block shows, plus
          // the live limits from claude.ai/api/oauth/usage when it
          // can be reached.
          dropMessage('📊 reading usage…');
          void Promise.all([
            readClaudeSubscription().catch(() => null),
            readClaudeDailyActivity().catch(() => null),
            readClaudeUsageLimits().catch(() => null),
          ]).then(([sub, activity, limits]) => {
            const lines: string[] = [];
            if (sub?.subscription_type) {
              const tier = sub.subscription_type.toUpperCase();
              const tierLabel = sub.rate_limit_tier
                ? `${tier} (${sub.rate_limit_tier})`
                : tier;
              lines.push(`Plan: ${tierLabel}`);
            }
            if (activity?.today) {
              lines.push(
                `Today: ${activity.today.message_count} msg · ${activity.today.session_count} sess · ${activity.today.tool_call_count} tool calls`,
              );
            }
            if (activity?.all_time) {
              lines.push(
                `All time: ${activity.all_time.message_count.toLocaleString()} msg · ${activity.all_time.session_count.toLocaleString()} sess`,
              );
            }
            if (limits && !limits.error) {
              const pct = (b: { utilization: number }): string =>
                `${(b.utilization * 100).toFixed(0)}%`;
              const at = (b: { resets_at: string }): string => {
                const d = new Date(b.resets_at);
                return Number.isNaN(d.getTime()) ? '?' : d.toLocaleString();
              };
              lines.push(
                `5h window: ${pct(limits.five_hour)} · resets ${at(limits.five_hour)}`,
              );
              lines.push(
                `7d all: ${pct(limits.seven_day)} · 7d sonnet: ${pct(limits.seven_day_sonnet)} · resets ${at(limits.seven_day)}`,
              );
            } else if (limits?.error) {
              lines.push(`(live limits unavailable: ${limits.error})`);
            }
            if (lines.length === 0) {
              dropMessage('No usage data available — try `claude login` first.');
            } else {
              dropMessage(lines.join('\n'));
            }
          });
          return true;
        }
        case 'agents':
          void openExternalUrl('https://claude.ai/agents').catch(() => {});
          dropMessage('Opening claude.ai/agents…');
          return true;
        case 'privacy':
          void openExternalUrl('https://www.anthropic.com/privacy').catch(() => {});
          dropMessage('Opening anthropic.com/privacy…');
          return true;
        case 'upgrade':
          void openExternalUrl('https://claude.ai/upgrade').catch(() => {});
          dropMessage('Opening claude.ai/upgrade…');
          return true;
        case 'context':
        case 'compact':
        case 'model':
        case 'init':
        case 'review':
        case 'security-review':
        case 'extra-usage':
        case 'insights':
        case 'team-onboarding':
        case 'heapdump':
        case 'exit':
        case 'reset':
          dropMessage(
            `/${cmd} only runs in claude's native TUI. Not yet implemented in chat mode.`,
          );
          return true;
        default:
          // Unknown slash → let it go to claude (might be a plugin).
          return false;
      }
    },
    [lastTurn],
  );

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (!text || !termId) return;
    setInput('');
    // Intercept client-side slash commands BEFORE shipping to claude
    // — otherwise claude wraps them in useless XML and the user sees
    // junk in the chat.
    if (text.startsWith('/') && handleSlashCommand(text)) {
      return;
    }
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
  }, [input, termId, handleSlashCommand]);

  const headerLabel = useMemo(
    () => (sessionId ? `claude · ${sessionId.slice(0, 8)}` : 'claude · starting…'),
    [sessionId],
  );

  // Set of toolUseIds whose result has not yet arrived. Drives the
  // pulsing "running" indicator on tool_use bubbles. A tool is "done"
  // when claude sends back a (result) bubble pointing at the same
  // toolUseId.
  const runningTools = useMemo(() => {
    const started = new Set<string>();
    const finished = new Set<string>();
    for (const m of messages) {
      if (m.kind !== 'tool_use') continue;
      if (m.tool === '(result)') {
        if (m.toolUseId) finished.add(m.toolUseId);
      } else if (m.toolUseId) {
        started.add(m.toolUseId);
      }
    }
    const out = new Set<string>();
    for (const id of started) if (!finished.has(id)) out.add(id);
    return out;
  }, [messages]);

  // Show a "claude is thinking" placeholder at the bottom of the log
  // when busy AND there's no in-progress streaming bubble for the user
  // to watch grow. Prevents the dead-air feeling between message_start
  // and the first content_block_start, OR while claude is processing
  // a long tool result before its next assistant turn.
  const showPendingPlaceholder = useMemo(() => {
    if (!busy) return false;
    // If the most recent message is an assistant_text bubble that's
    // currently being filled (no message_stop yet for its block), the
    // streaming caret already gives feedback. Don't double up.
    const last = messages[messages.length - 1];
    if (last && last.kind === 'assistant_text' && last.text.length > 0) return false;
    return true;
  }, [busy, messages]);

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
          opacity: 0.9,
          gap: 8,
        }}
      >
        <span title={cwd} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {headerLabel}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {busy ? (
            <ThinkingIndicator />
          ) : lastTurn ? (
            <span
              style={{
                color: lastTurn.ok ? 'inherit' : 'var(--color-danger)',
                opacity: 0.75,
              }}
            >
              {(lastTurn.durationMs / 1000).toFixed(1)}s · ${lastTurn.costUsd.toFixed(4)}
            </span>
          ) : (
            <span style={{ opacity: 0.5 }}>idle</span>
          )}
        </span>
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
          <MessageBubble
            key={m.uid}
            m={m}
            running={
              m.kind === 'tool_use' && m.tool !== '(result)' && runningTools.has(m.toolUseId)
            }
          />
        ))}
        {showPendingPlaceholder && <PendingPlaceholder />}
      </div>

      <ChatInput
        input={input}
        setInput={setInput}
        send={send}
        slashCommands={slashCommands}
        // Always enabled once spawned. claude code in
        // --input-format=stream-json mode queues incoming user
        // turns — you can type a follow-up while the previous one is
        // still streaming and claude will pick it up after the
        // current turn ends.
        canSend={Boolean(termId)}
        spawning={!termId}
        busy={busy}
        onInterrupt={() => {
          if (!termId) return;
          void chatInterrupt(termId).catch((e) =>
            console.warn('[Deepthix][ChatPane] interrupt failed', e),
          );
        }}
      />
    </div>
  );
}

// ─── Input + slash command autocomplete ─────────────────────────────────

function ChatInput({
  input,
  setInput,
  send,
  slashCommands,
  canSend,
  spawning,
  busy,
  onInterrupt,
}: {
  input: string;
  setInput: (v: string) => void;
  send: () => void;
  slashCommands: string[];
  canSend: boolean;
  spawning: boolean;
  busy: boolean;
  /** Called when the user clicks Stop while claude is mid-turn. */
  onInterrupt: () => void;
}): React.JSX.Element {
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Shell-style history navigation. Up arrow when caret is on the
  // first line goes to the previous sent message; Down comes back
  // forward; past the newest the input restores to whatever the
  // user was drafting before they navigated.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [draftBeforeNav, setDraftBeforeNav] = useState<string>('');
  // Wrap `send` so we can capture into the history without leaking
  // that wiring into the parent.
  const sendAndArchive = useCallback((): void => {
    const text = input.trim();
    if (!text) return;
    setHistory((h) => {
      // De-dupe consecutive identical sends so up-arrow doesn't make
      // you press through five copies of the same message.
      if (h[h.length - 1] === text) return h;
      return [...h, text].slice(-100); // keep last 100
    });
    setHistoryIdx(null);
    setDraftBeforeNav('');
    send();
  }, [input, send]);

  // What we actually let the user pick from the `/` popup. Anything
  // listed here either:
  //   (a) we handle CLIENT-SIDE in handleSlashCommand (works), OR
  //   (b) was advertised in claude's system/init `slash_commands`
  //       (plugin slash command — works because the plugin layer
  //       runs server-side regardless of TUI/print mode).
  //
  // The TUI-only built-ins (/agents, /privacy, /model, etc.) used to
  // be hardcoded here too, but they don't actually run in stream-json
  // mode and the user just got a wall of XML noise back from claude.
  // Hidden now — handleSlashCommand still catches them if typed and
  // shows a friendlier "not supported" notice.
  const allSlashCommands = useMemo(() => {
    const clientSide = [
      'help',
      'clear',
      'cost',
      'usage',
      'agents',
      'privacy',
      'upgrade',
    ];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of [...slashCommands, ...clientSide]) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
    return out.sort();
  }, [slashCommands]);

  // Show the slash popup when the input starts with `/` and the user
  // has typed at most one line (still composing the command name —
  // multi-line means they're past the command).
  const showSlash = useMemo(() => {
    if (allSlashCommands.length === 0) return false;
    if (!input.startsWith('/')) return false;
    if (input.includes('\n')) return false;
    return true;
  }, [input, allSlashCommands]);

  const filtered = useMemo(() => {
    if (!showSlash) return [];
    const q = input.slice(1).toLowerCase();
    const matches = allSlashCommands.filter((c) => c.toLowerCase().includes(q));
    // Surface all matches (capped at 30) — the popup scrolls. Users
    // narrow by typing more, not by being forced to memorise.
    return matches.slice(0, 30);
  }, [input, allSlashCommands, showSlash]);

  // Reset selection whenever the filter changes shape.
  useEffect(() => {
    setSelectedIdx((i) => (i >= filtered.length ? 0 : i));
  }, [filtered]);

  const pick = useCallback(
    (cmd: string) => {
      // Replace whatever the user typed by the chosen command + a
      // trailing space so they can append args before hitting enter.
      setInput(`/${cmd} `);
    },
    [setInput],
  );

  return (
    <div style={{ position: 'relative' }}>
      {showSlash && filtered.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 8,
            right: 8,
            marginBottom: 4,
            background: 'var(--color-bg-dark)',
            border: '2px solid var(--color-border)',
            boxShadow: 'var(--shadow-pixel)',
            zIndex: 10,
            maxHeight: 240,
            overflow: 'auto',
            fontSize: '12px',
          }}
        >
          {filtered.map((cmd, i) => (
            <button
              key={cmd}
              type="button"
              onMouseDown={(e) => {
                // mousedown not click — click loses textarea focus first
                // and the closing-on-blur causes a flicker.
                e.preventDefault();
                pick(cmd);
              }}
              onMouseEnter={() => setSelectedIdx(i)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                background:
                  i === selectedIdx ? 'var(--color-accent)' : 'transparent',
                color: i === selectedIdx ? 'var(--color-bg-dark)' : 'inherit',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '12px',
              }}
            >
              /{cmd}
            </button>
          ))}
        </div>
      )}
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
          onChange={(e) => {
            setInput(e.target.value);
            // Any manual edit aborts history navigation — the user is
            // composing fresh now, not browsing past sends.
            if (historyIdx !== null) setHistoryIdx(null);
          }}
          onKeyDown={(e) => {
            if (showSlash && filtered.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIdx((i) => Math.max(0, i - 1));
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                pick(filtered[selectedIdx]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setInput('');
                return;
              }
            }
            // Shell-style history: Up/Down navigate sent messages
            // when the caret is on the first line (so multi-line
            // edit still does normal vertical cursor moves). Down
            // doesn't need the on-first-line check — it's only ever
            // active when historyIdx !== null, meaning the input was
            // populated from history (always one or more lines).
            const target = e.target as HTMLTextAreaElement;
            const onFirstLine =
              target.value.slice(0, target.selectionStart).indexOf('\n') === -1;
            if (e.key === 'ArrowUp' && onFirstLine && history.length > 0) {
              e.preventDefault();
              const next =
                historyIdx === null ? history.length - 1 : Math.max(0, historyIdx - 1);
              if (historyIdx === null) setDraftBeforeNav(input);
              setHistoryIdx(next);
              setInput(history[next]);
              return;
            }
            if (e.key === 'ArrowDown' && historyIdx !== null) {
              e.preventDefault();
              const next = historyIdx + 1;
              if (next >= history.length) {
                setHistoryIdx(null);
                setInput(draftBeforeNav);
              } else {
                setHistoryIdx(next);
                setInput(history[next]);
              }
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendAndArchive();
            }
          }}
          placeholder={
            spawning
              ? 'Spawning claude…'
              : 'Message claude (⏎ send, ⇧⏎ newline, ↑/↓ history, / for commands)'
          }
          disabled={spawning}
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
          onClick={sendAndArchive}
          disabled={!canSend || !input.trim()}
          title={busy ? 'Send (queues — claude is still on previous turn)' : 'Send (⏎)'}
          style={{
            padding: '4px 16px',
            background: canSend && input.trim() ? 'var(--color-accent)' : 'transparent',
            color: canSend && input.trim() ? 'var(--color-bg-dark)' : 'inherit',
            border: '2px solid var(--color-border)',
            boxShadow: canSend && input.trim() ? 'var(--shadow-pixel)' : 'none',
            cursor: canSend && input.trim() ? 'pointer' : 'default',
            fontFamily: 'var(--font-pixel)',
            fontSize: '13px',
            opacity: canSend && input.trim() ? 1 : 0.4,
          }}
        >
          {input.trim() && busy ? 'Queue' : 'Send'}
        </button>
        {busy && (
          <button
            type="button"
            onClick={onInterrupt}
            title="Stop (interrupt the current turn)"
            style={{
              padding: '4px 12px',
              background: 'var(--color-danger)',
              color: 'var(--color-bg-dark)',
              border: '2px solid var(--color-border)',
              boxShadow: 'var(--shadow-pixel)',
              cursor: 'pointer',
              fontFamily: 'var(--font-pixel)',
              fontSize: '13px',
            }}
          >
            ⏹ Stop
          </button>
        )}
        <MicButton disabled={spawning} />
      </div>
    </div>
  );
}

/**
 * Push-to-talk mic button next to Send. mousedown starts recording,
 * mouseup stops + transcribes + injects the result via the existing
 * VoiceRecorder pipeline (it listens for `deepthix:voice:start` /
 * `deepthix:voice:stop` window events). Equivalent to holding ⌘M
 * — both work, the button is just discoverable.
 */
function MicButton({ disabled }: { disabled: boolean }): React.JSX.Element {
  const [holding, setHolding] = useState(false);

  const start = useCallback(() => {
    if (disabled) return;
    setHolding(true);
    window.dispatchEvent(new Event('deepthix:voice:start'));
  }, [disabled]);
  const stop = useCallback(() => {
    if (!holding) return;
    setHolding(false);
    window.dispatchEvent(new Event('deepthix:voice:stop'));
  }, [holding]);

  return (
    <button
      type="button"
      title="Push to talk (⌘M)"
      disabled={disabled}
      onMouseDown={start}
      onMouseUp={stop}
      onMouseLeave={stop}
      onTouchStart={start}
      onTouchEnd={stop}
      style={{
        padding: '4px 10px',
        background: holding ? 'var(--color-danger)' : 'transparent',
        color: holding ? 'var(--color-bg-dark)' : 'inherit',
        border: '2px solid var(--color-border)',
        boxShadow: holding ? 'var(--shadow-pixel)' : 'none',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'var(--font-pixel)',
        fontSize: '13px',
        opacity: disabled ? 0.4 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        userSelect: 'none',
      }}
    >
      <span>{holding ? '🔴' : '🎙'}</span>
      <span style={{ fontSize: 10, opacity: 0.7 }}>⌘M</span>
    </button>
  );
}

// ─── Message bubbles ────────────────────────────────────────────────────

/**
 * Bottom-of-log placeholder shown while claude is busy and there's no
 * actively-streaming text bubble for the user to watch grow. Three
 * pulsing dots in a left-aligned bubble that mirrors the assistant
 * style — visually consistent with the "claude is typing" pattern
 * users know from chat apps.
 */
function PendingPlaceholder(): React.JSX.Element {
  const dot: React.CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--color-text)',
    display: 'inline-block',
    animation: 'pulse 1.2s ease-in-out infinite',
  };
  return (
    <div
      className="dt-chat-msg"
      style={{
        alignSelf: 'flex-start',
        background: 'var(--color-bg-dark)',
        color: 'var(--color-text)',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        padding: '8px 12px',
        fontSize: 12,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        opacity: 0.85,
      }}
    >
      <span style={{ opacity: 0.7, marginRight: 4 }}>claude is thinking</span>
      <span style={{ ...dot, animationDelay: '0s' }} />
      <span style={{ ...dot, animationDelay: '0.2s' }} />
      <span style={{ ...dot, animationDelay: '0.4s' }} />
    </div>
  );
}

function ThinkingIndicator(): React.JSX.Element {
  // Coloured + bolded so it actually reads as ACTIVE in the header
  // rather than disappearing into the surrounding chrome.
  const dot: React.CSSProperties = {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'var(--color-accent)',
    display: 'inline-block',
    animation: 'pulse 1.2s ease-in-out infinite',
  };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: 'var(--color-accent)',
        fontWeight: 'bold',
      }}
    >
      <span style={{ marginRight: 4 }}>thinking</span>
      <span style={{ ...dot, animationDelay: '0s' }} />
      <span style={{ ...dot, animationDelay: '0.2s' }} />
      <span style={{ ...dot, animationDelay: '0.4s' }} />
    </span>
  );
}

function MessageBubble({ m, running }: { m: Message; running?: boolean }): React.JSX.Element {
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
      return <ToolBubble m={m} running={Boolean(running)} />;
    case 'system':
      return (
        <div
          className="dt-chat-msg"
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
      // The live stream no longer emits this — turn end goes to the
      // header. Kept for the (theoretical) history record case so we
      // never break on legacy data; renders the same compact pill.
      return (
        <div
          className="dt-chat-msg"
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
          className="dt-chat-msg"
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
      className="dt-chat-msg"
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

/**
 * Per-tool visual config + one-line summary derived from the tool's
 * input. Adding a new tool: drop a case in `summarizeTool` and pick
 * an icon + accent class. Anything not listed falls into the generic
 * "tool" branch (plain wrench + neutral border).
 */
interface ToolStyle {
  icon: string;
  /** A CSS color expression used for the left accent bar. */
  accent: string;
  /** One-line summary of the input — what the user actually wants to
   *  read at a glance instead of the raw JSON dump. */
  summary: string;
}

function summarizeTool(name: string, input: unknown): ToolStyle {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const get = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string) : '');
  const trunc = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const basename = (p: string): string => p.split('/').filter(Boolean).slice(-1)[0] || p;

  switch (name) {
    case 'Bash': {
      const cmd = get('command');
      return { icon: '$', accent: '#34d399', summary: cmd ? trunc(cmd, 90) : 'shell command' };
    }
    case 'Read': {
      const p = get('file_path');
      const ol = obj.offset && obj.limit ? ` · L${obj.offset}-${(obj.offset as number) + (obj.limit as number)}` : '';
      return { icon: '◀', accent: '#a78bfa', summary: p ? `${basename(p)}${ol}` : 'read file' };
    }
    case 'Edit':
    case 'MultiEdit': {
      const p = get('file_path');
      const old = get('old_string');
      const replacements = Array.isArray(obj.edits) ? (obj.edits as unknown[]).length : 1;
      return {
        icon: '✎',
        accent: '#a78bfa',
        summary: p
          ? `${basename(p)} · ${replacements} edit${replacements > 1 ? 's' : ''}${old ? ` · "${trunc(old.split('\n')[0], 30)}"` : ''}`
          : 'edit file',
      };
    }
    case 'Write': {
      const p = get('file_path');
      const sz = typeof obj.content === 'string' ? (obj.content as string).length : 0;
      return {
        icon: '⬇',
        accent: '#a78bfa',
        summary: p ? `${basename(p)}${sz ? ` · ${formatSize(sz)}` : ''}` : 'write file',
      };
    }
    case 'NotebookEdit': {
      const p = get('notebook_path');
      return { icon: '✎', accent: '#a78bfa', summary: p ? basename(p) : 'edit notebook' };
    }
    case 'Grep': {
      const pattern = get('pattern');
      const path = get('path');
      return {
        icon: '⌕',
        accent: '#fbbf24',
        summary: `"${trunc(pattern, 40)}"${path ? ` in ${basename(path) || path}` : ''}`,
      };
    }
    case 'Glob': {
      const pattern = get('pattern');
      return { icon: '⌕', accent: '#fbbf24', summary: pattern || 'glob' };
    }
    case 'WebFetch': {
      const url = get('url');
      return { icon: '⌲', accent: '#60a5fa', summary: url ? trunc(url.replace(/^https?:\/\//, ''), 70) : 'fetch web' };
    }
    case 'WebSearch': {
      const q = get('query');
      return { icon: '⌕', accent: '#60a5fa', summary: q ? `"${trunc(q, 60)}"` : 'web search' };
    }
    case 'Task':
    case 'Agent': {
      const desc = get('description') || get('subagent_type');
      const prompt = get('prompt');
      return {
        icon: '⚙',
        accent: '#f472b6',
        summary: desc || (prompt ? trunc(prompt, 60) : 'subagent'),
      };
    }
    case 'TodoWrite': {
      const todos = Array.isArray(obj.todos) ? (obj.todos as unknown[]).length : 0;
      return { icon: '☰', accent: '#9ca3af', summary: `${todos} todo${todos === 1 ? '' : 's'}` };
    }
    case 'AskUserQuestion': {
      const q = get('question');
      return { icon: '?', accent: '#f59e0b', summary: q ? trunc(q, 70) : 'ask user' };
    }
    case '(result)':
      return { icon: '◀', accent: 'var(--color-border)', summary: 'tool result' };
    default: {
      // mcp__server__tool naming convention from claude code.
      if (name.startsWith('mcp__')) {
        const parts = name.replace(/^mcp__/, '').split('__');
        return {
          icon: '◇',
          accent: '#ec4899',
          summary: parts.length > 1 ? `${parts[0]} → ${parts.slice(1).join('.')}` : name,
        };
      }
      return { icon: '✦', accent: 'var(--color-accent)', summary: name };
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ToolBubble({
  m,
  running,
}: {
  m: Extract<Message, { kind: 'tool_use' }>;
  running: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isResult = m.tool === '(result)';
  const style = useMemo(() => summarizeTool(m.tool, m.input), [m.tool, m.input]);

  // Auto-expand result bubbles since the result content IS the
  // information the user wants. Tool calls stay collapsed because
  // the summary is usually enough.
  const showDetail = expanded || isResult;

  const inputPreview = useMemo(() => {
    if (m.input == null) return '';
    try {
      return JSON.stringify(m.input, null, 2);
    } catch {
      return String(m.input);
    }
  }, [m.input]);

  return (
    <div
      className="dt-chat-msg"
      style={{
        alignSelf: 'flex-start',
        maxWidth: '92%',
        background: 'var(--color-bg-dark)',
        border: '2px solid var(--color-border)',
        borderLeft: `4px solid ${style.accent}`,
        boxShadow: 'var(--shadow-pixel)',
        fontSize: '12px',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={isResult ? '' : expanded ? 'Click to collapse' : 'Click to expand input'}
        disabled={isResult}
        style={{
          all: 'unset',
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: isResult ? 'default' : 'pointer',
          fontFamily: 'var(--font-pixel)',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            width: 18,
            height: 18,
            alignItems: 'center',
            justifyContent: 'center',
            background: style.accent,
            color: 'var(--color-bg-dark)',
            fontWeight: 'bold',
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          {style.icon}
        </span>
        <span style={{ fontWeight: 'bold', color: style.accent, flexShrink: 0 }}>{m.tool}</span>
        <span
          style={{
            opacity: 0.85,
            fontFamily: 'Menlo, Consolas, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {style.summary}
        </span>
        {running && (
          // Pulsing dot — the tool has been started but its result
          // hasn't come back yet. Disappears the moment claude sends
          // back the matching tool_result.
          <span
            title="running"
            style={{
              flexShrink: 0,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: style.accent,
              animation: 'pulse 1s ease-in-out infinite',
            }}
          />
        )}
        {!isResult && (
          <span style={{ opacity: 0.4, fontSize: 11, flexShrink: 0 }}>
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </button>
      <div
        className="dt-tool-detail"
        style={{
          maxHeight: showDetail ? 480 : 0,
          opacity: showDetail ? 1 : 0,
          padding: showDetail ? '0 10px 8px' : '0 10px',
        }}
      >
        {!isResult && inputPreview && (
          <pre
            style={{
              margin: 0,
              padding: '6px 8px',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              fontFamily: 'Menlo, Consolas, monospace',
              fontSize: 11,
              lineHeight: 1.4,
              overflow: 'auto',
              maxHeight: 280,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--color-text)',
            }}
          >
            {inputPreview}
          </pre>
        )}
        {m.result && (
          <div
            style={{
              marginTop: !isResult && inputPreview ? 6 : 0,
              padding: '6px 8px',
              background: m.result.isError ? 'var(--color-danger)' : 'var(--color-bg)',
              color: m.result.isError ? 'var(--color-bg-dark)' : 'var(--color-text)',
              border: '1px solid var(--color-border)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 280,
              overflow: 'auto',
              fontFamily: 'Menlo, Consolas, monospace',
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            {m.result.text.length > 4000
              ? `${m.result.text.slice(0, 4000)}\n…(truncated)`
              : m.result.text}
          </div>
        )}
      </div>
    </div>
  );
}
