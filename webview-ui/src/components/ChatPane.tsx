/* eslint-disable deepthix/no-inline-colors, deepthix/pixel-font */
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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  chatInterruptAndResume,
  chatKill,
  chatLoadHistory,
  chatResumeOtherSession,
  chatSendToolResult,
  chatSendUserText,
  chatSendUserWithAttachments,
  chatSetSessionId,
  chatSpawn,
  chatSwitchModel,
  listResumableSessions,
  openExternalUrl,
  readClaudeDailyActivity,
  readClaudeSubscription,
  readClaudeUsageLimits,
  readFileBytesBase64,
  type ResumableSession,
  rewindSession,
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
  /** Per-terminal agent id used by useAgentStatus so we can ping it
   *  whenever a chat_event arrives — JSONL-only detection lagged by
   *  ~2s (size poll cadence) which made the working dot flicker. */
  agentId?: number;
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

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
function isImagePathLocal(p: string): boolean {
  const dot = p.lastIndexOf('.');
  return dot >= 0 && IMAGE_EXTS.has(p.slice(dot + 1).toLowerCase());
}
function basenameLocal(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return slash >= 0 ? p.slice(slash + 1) : p;
}

interface PendingAttachment {
  uid: string;
  path: string;
  name: string;
  isImage: boolean;
  /** Inline data URL for the preview thumbnail (images only). */
  previewSrc?: string;
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
  | { kind: 'set_model'; model: string }
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
        const model = obj.model as string | undefined;
        const slash =
          (obj.slash_commands as string[] | undefined)?.filter(
            (s) => typeof s === 'string',
          ) ?? null;
        const actions: ParseAction[] = [];
        if (sid) actions.push({ kind: 'set_session', sessionId: sid });
        if (model) actions.push({ kind: 'set_model', model });
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
  agentId,
  onSessionReady,
}: Props): React.JSX.Element {
  const [termId, setTermId] = useState<string | null>(bindTermId ?? null);
  const [sessionId, setSessionId] = useState<string | null>(resumeSessionId ?? null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [currentEffort, setCurrentEffort] = useState<string | null>(null);
  const [showModelPicker, setShowModelPicker] = useState(false);
  // /resume → opens a picker listing resumable sessions for cwd.
  const [showResumePicker, setShowResumePicker] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Slash commands learned from the system/init event. Used to drive
   *  the autocomplete popup when the user types `/` at the start of
   *  the input. */
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  // Files dropped into the window stage here as previews. Send button
  // ships them with the next message; user can remove individuals.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
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
  // Refs kept in sync with component state/props so the chat_exit handler
  // (which closes over them) always sees the LATEST value when an idle
  // reap fires — even if the closure was set up when sessionId was still
  // null and the set_session action filled it in later.
  const sessionIdRef = useRef<string | null>(resumeSessionId ?? null);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const cwdRef = useRef<string>(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);
  const skipPermissionsRef = useRef<boolean>(skipPermissions ?? false);
  useEffect(() => {
    skipPermissionsRef.current = skipPermissions ?? false;
  }, [skipPermissions]);
  const currentModelRef = useRef<string | null>(null);
  useEffect(() => {
    currentModelRef.current = currentModel;
  }, [currentModel]);
  // Auto-respawn loop guard. When the Rust reaper is misconfigured
  // (DEEPTHIX_IDLE_TIMEOUT_MS=0 used to make it kill every 60s) the FE
  // would respawn → reap → respawn forever, painting an endless flicker
  // of "session paused / session reprise" bubbles. We track the last
  // auto-respawn timestamp; if a new idle exit fires within the
  // cooldown window, we stop auto-respawning and show a real error so
  // the user can recover instead of staring at the loop.
  const lastAutoRespawnMsRef = useRef<number>(0);
  const AUTO_RESPAWN_LOOP_WINDOW_MS = 2 * 60 * 1000;

  // Hydrate the message log from claude's own JSONL transcript on
  // mount when we're resuming a session. We don't depend on this for
  // claude itself — `--resume <id>` already gives the model its full
  // context — but the user expects to SEE the past conversation when
  // they reopen a session, not a blank pane.
  //
  // CRITICAL: only fire ONCE per mount, using the resumeSessionId we
  // had at mount. The prop is bound to entry.sessionId in the parent
  // (BottomPanel.tsx:288), which starts NULL for a fresh session and
  // flips to the real UUID after claude's system/init event. Re-running
  // on that null→uuid transition would re-load the JSONL — which now
  // contains the user's just-sent message — and prepend it on top of
  // the bubble we already added locally (and the streamed assistant
  // reply). Result: every message in a brand-new session appeared
  // twice. Capture the initial value in a ref and ignore later changes.
  const initialResumeSessionIdRef = useRef(resumeSessionId ?? null);
  useEffect(() => {
    const sid = initialResumeSessionIdRef.current;
    if (!sid) return;
    let cancelled = false;
    void chatLoadHistory(cwd, sid)
      .then((lines) => {
        if (cancelled) return;
        const restored: Message[] = [];
        for (const line of lines) {
          for (const m of parseHistoryRecord(line)) restored.push(m);
        }
        if (restored.length > 0) {
          setMessages((prev) => [...restored, ...prev]);
          console.info('[Deepthix][ChatPane] history loaded', {
            session: sid,
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
  }, [cwd]);

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
        onSessionReadyRef.current?.({ termId: res.term_id, sessionId: res.session_id });
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][ChatPane] spawn failed', e);
        setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, resumeSessionId, skipPermissions, bindTermId]);

  // Subscribe to events for THIS termId.
  useEffect(() => {
    if (!termId) return;
    let unEvent: (() => void) | null = null;
    let unExit: (() => void) | null = null;
    let cancelled = false;
    void onChatEvent((evt) => {
      if (evt.term_id !== termIdRef.current) return;
      // Bypass the JSONL polling pipeline — every chat_event for THIS
      // agent is direct evidence the session is alive RIGHT NOW. The
      // window-level dispatch pings useAgentStatus which lights the
      // green dot in the sidebar / overview / tabs without waiting on
      // the 2s JSONL size poll.
      if (typeof agentId === 'number') {
        window.postMessage({ type: 'agentJsonlActivity', id: agentId }, '*');
      }
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
            onSessionReadyRef.current?.({ termId: tid, sessionId: a.sessionId });
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
          case 'set_model': {
            setCurrentModel(a.model);
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
      // Was this exit triggered by Stop → interrupt-and-resume?
      // If yes, the Rust side already spawned a fresh claude under
      // the same term_id; we only need to surface "turn stopped" and
      // clear busy. If no, fall through to the regular exit notice.
      if (interruptedRef.current) {
        interruptedRef.current = false;
        interruptingRef.current = false;
        if (interruptSafetyTimerRef.current) {
          clearTimeout(interruptSafetyTimerRef.current);
          interruptSafetyTimerRef.current = null;
        }
        console.info('[Deepthix][ChatPane] exit was intentional (interrupt+resume)');
        setMessages((prev) => [
          ...prev,
          {
            kind: 'system',
            uid: uid(),
            ts: Date.now(),
            subtype: 'exit',
            summary: '✓ turn stopped — session resumed',
          },
        ]);
        setBusy(false);
        return;
      }
      if (evt.subtype === 'idle') {
        idleRef.current = true;
        // Loop guard: if the previous auto-respawn happened less than
        // AUTO_RESPAWN_LOOP_WINDOW_MS ago, the reaper is killing the
        // session faster than the user can use it — respawning again
        // would just paint another flicker line. Surface a real error
        // and stop. The user can either fix DEEPTHIX_IDLE_TIMEOUT_MS or
        // click +Session to start a fresh tab.
        const sinceLastRespawn = Date.now() - lastAutoRespawnMsRef.current;
        if (
          lastAutoRespawnMsRef.current > 0 &&
          sinceLastRespawn < AUTO_RESPAWN_LOOP_WINDOW_MS
        ) {
          console.warn('[Deepthix][ChatPane] auto-respawn loop detected — stopping', {
            sinceLastRespawnMs: sinceLastRespawn,
          });
          setMessages((prev) => [
            ...prev,
            {
              kind: 'system',
              uid: uid(),
              ts: Date.now(),
              subtype: 'exit',
              summary:
                "⚠ la session est tuée plus vite que vous ne pouvez l'utiliser " +
                '(reaper trop agressif) — vérifiez DEEPTHIX_IDLE_TIMEOUT_MS, ' +
                "puis fermez/rouvrez l'app",
            },
          ]);
          setBusy(false);
          return;
        }
        lastAutoRespawnMsRef.current = Date.now();
        const idleMin = Math.round((evt.idle_ms ?? 0) / 60000);
        setMessages((prev) => [
          ...prev,
          {
            kind: 'system',
            uid: uid(),
            ts: Date.now(),
            subtype: 'exit',
            summary: `💤 session paused after ${idleMin} min idle — reprenant…`,
          },
        ]);
        setBusy(false);
        console.info('[Deepthix][ChatPane] idle reap → auto-respawn', {
          oldTermId: evt.term_id,
          sessionId: sessionIdRef.current,
          cwd: cwdRef.current,
        });
        void chatSpawn({
          cwd: cwdRef.current,
          resume_session_id: sessionIdRef.current,
          skip_permissions: skipPermissionsRef.current,
          model: currentModelRef.current,
        })
          .then((res) => {
            console.info('[Deepthix][ChatPane] auto-respawn ok', {
              newTermId: res.term_id,
              newSessionId: res.session_id,
            });
            setTermId(res.term_id);
            if (res.session_id) setSessionId(res.session_id);
            onSessionReadyRef.current?.({ termId: res.term_id, sessionId: res.session_id });
            idleRef.current = false;
            setMessages((prev) => [
              ...prev,
              {
                kind: 'system',
                uid: uid(),
                ts: Date.now(),
                subtype: 'exit',
                summary: '✓ session reprise — vous pouvez continuer',
              },
            ]);
          })
          .catch((e) => {
            console.error('[Deepthix][ChatPane] auto-respawn failed', e);
            setMessages((prev) => [
              ...prev,
              {
                kind: 'system',
                uid: uid(),
                ts: Date.now(),
                subtype: 'exit',
                summary: `⚠ auto-respawn a échoué (${e instanceof Error ? e.message : String(e)}) — fermez et rouvrez l'app`,
              },
            ]);
          });
        return;
      }
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
    // intentionally NOT depending on onSessionReady — see the
    // onSessionReadyRef declaration above for why (Tauri listen()
    // duplication = streamed deltas multiplied N times in chat).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  // Auto-scroll to the bottom on new messages.
  //   - First time messages appear (history hydration on session
  //     reopen): force-scroll regardless of position.
  //   - When the user just sent a message (explicit action): force-
  //     scroll regardless of position.
  //   - Otherwise: scroll iff the user is currently following the
  //     bottom. We track this via a scroll-event listener (not by
  //     measuring inside the message effect) — a single streaming
  //     delta can add more than 80px of content, which would push the
  //     measured distance above the threshold and freeze auto-follow
  //     for the rest of the reply. The listener captures intent
  //     BEFORE the next render: if the user scrolls up to read
  //     history, follow stops; when they scroll back to within 80px
  //     of the bottom, follow resumes.
  const initialScrollDoneRef = useRef(false);
  const forceScrollNextRef = useRef(false);
  const isAtBottomRef = useRef(true);
  // Set true by the Stop button just before it kills + respawns the
  // session; the next chat_exit handler reads it to know it should
  // suppress the "claude exited" system bubble (the exit was on
  // purpose and a fresh claude is already on the way).
  const interruptedRef = useRef(false);
  // Tracks the safety timer that auto-clears busy if chat_exit never
  // arrives after Stop (rare but possible if claude hangs in a tool
  // call that ignores SIGINT).
  const interruptSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latch: prevents Stop from being fired multiple times in quick
  // succession (rapid Ctrl+C / button mash) which would queue redundant
  // chat_interrupt_and_resume calls.
  const interruptingRef = useRef(false);
  // Set true by the chat_exit handler when subtype === 'idle' (the
  // background reaper killed the session). Read by send() to know it
  // must respawn claude (with --resume sessionId) before writing the
  // user's text — otherwise chat_send_user_text errors with "no chat
  // session" because the term_id was removed from ChatManager.
  const idleRef = useRef(false);
  // Stable ref so we can drop onSessionReady from effect deps. The
  // parent (BottomPanel) passes an inline arrow, which gets a new
  // reference on every parent render — when this ref was a dep, the
  // chat_event subscription effect re-ran on every parent render.
  // listen() registers the subscription EAGERLY (before its Promise
  // resolves), so each re-run added a fresh active listener while the
  // old one was still in the cancellation window. Deltas reaching N
  // active listeners got appended N times — claude's reply repeated
  // 5+ times in the chat (user-reported bug).
  const onSessionReadyRef = useRef(onSessionReady);
  useEffect(() => {
    onSessionReadyRef.current = onSessionReady;
  }, [onSessionReady]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll(): void {
      if (!el) return;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      isAtBottomRef.current = distance < 80;
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    console.debug('[Deepthix][ChatPane] scroll listener attached');
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Hidden via display:none on parent (e.g., user switched to OVERVIEW
    // and the SESSIONS layout is mounted but hidden). scrollHeight /
    // clientHeight read 0 in that state, so any `scrollTop = scrollHeight`
    // here silently resets to 0 — and when the user comes back, they
    // land at the top of the conversation. The ResizeObserver below
    // re-pins the scroll when the container becomes visible again.
    if (el.clientHeight === 0) {
      console.debug('[Deepthix][ChatPane] skip auto-scroll — pane hidden');
      return;
    }
    // Don't yank the scroll while the user is selecting text inside
    // the conversation. Streaming deltas would otherwise re-pin to
    // bottom on every chunk and the selection anchor would jump,
    // making it impossible to copy a quote out of claude's reply.
    const sel = window.getSelection();
    if (
      sel &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      el.contains(sel.getRangeAt(0).commonAncestorContainer)
    ) {
      console.debug('[Deepthix][ChatPane] skip auto-scroll — active selection');
      return;
    }
    if (!initialScrollDoneRef.current && messages.length > 0) {
      el.scrollTop = el.scrollHeight;
      initialScrollDoneRef.current = true;
      isAtBottomRef.current = true;
      return;
    }
    if (forceScrollNextRef.current) {
      el.scrollTop = el.scrollHeight;
      forceScrollNextRef.current = false;
      isAtBottomRef.current = true;
      return;
    }
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Re-pin to bottom when the pane becomes visible again. Triggered
  // by ResizeObserver — clientHeight goes from 0 (display:none on a
  // parent) back to a real height when the user navigates back to
  // SESSIONS. We only re-pin if the user was following (isAtBottomRef);
  // if they were reading history before switching tabs, we leave them
  // where they were.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastHeight = el.clientHeight;
    const obs = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (lastHeight === 0 && h > 0 && isAtBottomRef.current) {
        el.scrollTop = el.scrollHeight;
        console.debug('[Deepthix][ChatPane] re-pinned to bottom on visibility', {
          scrollHeight: el.scrollHeight,
        });
      }
      lastHeight = h;
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Voice recorder bridge — when the user uses ⌘M / the mic button,
  // VoiceRecorder ships the transcript through chat_send_user_text
  // directly. We still need to add a user bubble locally so the user
  // sees feedback (otherwise claude's response appears out of nowhere
  // ~3s later). VoiceRecorder dispatches `deepthix:chat:user-text`
  // with { termId, text }; we react to it iff the termId matches.
  useEffect(() => {
    if (!termId) return;
    function onVoiceUserText(ev: Event): void {
      const detail = (ev as CustomEvent<{ termId: string; text: string }>).detail;
      if (!detail || detail.termId !== termId) return;
      // Same explicit-action treatment as a typed Send: snap the
      // user back to the bottom so they see what their voice produced.
      forceScrollNextRef.current = true;
      setMessages((prev) => [
        ...prev,
        { kind: 'user', uid: uid(), ts: Date.now(), text: detail.text },
      ]);
      setBusy(true);
    }
    window.addEventListener('deepthix:chat:user-text', onVoiceUserText);
    return () => window.removeEventListener('deepthix:chat:user-text', onVoiceUserText);
  }, [termId]);

  // Voice → composer: VoiceRecorder no longer auto-sends. It dispatches
  // `deepthix:chat:append-input` with { termId, text } so the user can
  // review / edit / extend the transcript before clicking Send.
  // Multiple recordings accumulate (separated by a space).
  useEffect(() => {
    if (!termId) return;
    function onAppendInput(ev: Event): void {
      const detail = (ev as CustomEvent<{ termId: string; text: string }>).detail;
      if (!detail || detail.termId !== termId) return;
      const next = detail.text.trim();
      if (!next) return;
      setInput((prev) => {
        const cur = prev.trimEnd();
        if (!cur) return next;
        // If the existing draft ends with sentence-stop punctuation,
        // start a new sentence with a space; else append with a space.
        return `${cur} ${next}`;
      });
      console.info('[Deepthix][ChatPane] voice transcript appended to composer', {
        chars: next.length,
      });
    }
    window.addEventListener('deepthix:chat:append-input', onAppendInput);
    return () => window.removeEventListener('deepthix:chat:append-input', onAppendInput);
  }, [termId]);

  // Drop-target bridge — TerminalDropTarget catches the OS drag-drop
  // and dispatches `deepthix:chat:add-attachments` with { termId,
  // paths }. We stage them as previews instead of sending immediately
  // (per user request: "faut ajouter le screen en piece jointe voir
  // une preview et des que je fais envoyer ca senvoie"). Send() picks
  // them up and ships everything together via
  // chat_send_user_with_attachments.
  useEffect(() => {
    if (!termId) return;
    function onAddAttachments(ev: Event): void {
      const detail = (ev as CustomEvent<{ termId: string; paths: string[] }>).detail;
      if (!detail || detail.termId !== termId) return;
      const paths = detail.paths.filter((p) => typeof p === 'string' && p.length > 0);
      if (paths.length === 0) return;
      console.info('[Deepthix][ChatPane] staging attachments', {
        termId,
        count: paths.length,
        first: paths[0],
      });
      // Add each as a placeholder immediately so the user sees them
      // appear, then load previews asynchronously per file.
      const placeholders: PendingAttachment[] = paths.map((p) => ({
        uid: uid(),
        path: p,
        name: basenameLocal(p),
        isImage: isImagePathLocal(p),
      }));
      setPendingAttachments((prev) => [...prev, ...placeholders]);
      placeholders.forEach((att) => {
        if (!att.isImage) return;
        void readFileBytesBase64(att.path)
          .then((bytes) => {
            setPendingAttachments((prev) =>
              prev.map((a) =>
                a.uid === att.uid
                  ? { ...a, previewSrc: `data:${bytes.mime};base64,${bytes.b64}` }
                  : a,
              ),
            );
          })
          .catch((e) => {
            console.warn('[Deepthix][ChatPane] preview load failed', {
              path: att.path,
              error: e,
            });
          });
      });
    }
    window.addEventListener('deepthix:chat:add-attachments', onAddAttachments);
    return () => {
      window.removeEventListener('deepthix:chat:add-attachments', onAddAttachments);
    };
  }, [termId]);

  const removeAttachment = useCallback((attUid: string): void => {
    setPendingAttachments((prev) => prev.filter((a) => a.uid !== attUid));
  }, []);

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
              '  /model <name> — switch model mid-session (sonnet, opus, haiku)',
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
              // Strip noisy JSON dumps; rate-limit messages are common
              // and we just want a one-line "try again later" hint.
              const raw = limits.error;
              let friendly = raw;
              if (/HTTP 429|rate.?limited/i.test(raw)) {
                friendly = 'rate-limited (claude.ai/api/oauth/usage) — try in a few minutes';
              } else if (raw.length > 120) {
                friendly = `${raw.slice(0, 120)}…`;
              }
              lines.push(`Live limits: ${friendly}`);
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
        case 'model': {
          // /model           → open the picker popup (no arg needed)
          // /model <name>    → switch directly without the popup
          const spaceIdx = cmdLine.indexOf(' ');
          const arg = spaceIdx === -1 ? '' : cmdLine.slice(spaceIdx).trim();
          if (!arg) {
            setShowModelPicker(true);
            return true;
          }
          if (!termId) {
            dropMessage('No active session — open one first.');
            return true;
          }
          dropMessage(`Switching model to ${arg}…`);
          void chatSwitchModel(termId, arg)
            .then(() => dropMessage(`Model switched to ${arg}. Conversation context preserved.`))
            .catch((e) => {
              const msg = e instanceof Error ? e.message : String(e);
              dropMessage(`Model switch failed: ${msg}`);
            });
          return true;
        }
        case 'resume': {
          // /resume                → open the picker
          // /resume <session_id>   → resume directly without the popup
          const spaceIdx = cmdLine.indexOf(' ');
          const arg = spaceIdx === -1 ? '' : cmdLine.slice(spaceIdx).trim();
          if (!termId) {
            dropMessage('No active session — open one first.');
            return true;
          }
          if (!arg) {
            setShowResumePicker(true);
            return true;
          }
          dropMessage(`Resuming session ${arg}…`);
          void chatResumeOtherSession(termId, arg, currentModel)
            .then(() => {
              dropMessage(
                `✓ Resumed ${arg}. The conversation history will reload — give it a moment.`,
              );
            })
            .catch((e) => {
              const msg = e instanceof Error ? e.message : String(e);
              dropMessage(`Resume failed: ${msg}`);
            });
          return true;
        }
        case 'rewind': {
          // /rewind        → rewind 1 turn
          // /rewind <N>    → rewind N turns
          if (!termId || !sessionId) {
            dropMessage('No active session — nothing to rewind.');
            return true;
          }
          const spaceIdx = cmdLine.indexOf(' ');
          const arg = spaceIdx === -1 ? '' : cmdLine.slice(spaceIdx).trim();
          const n = arg ? Number.parseInt(arg, 10) : 1;
          if (!Number.isFinite(n) || n < 1) {
            dropMessage(`Invalid rewind count: "${arg}". Usage: /rewind [N]`);
            return true;
          }
          dropMessage(`⏪ Rewinding last ${n} user turn${n === 1 ? '' : 's'}…`);
          void rewindSession(cwd, sessionId, n)
            .then((newCount) => {
              dropMessage(
                `✓ Rewound ${n} turn${n === 1 ? '' : 's'}. Restarting claude on the truncated transcript (${newCount} JSONL lines kept).`,
              );
              // Respawn so the live ChatChild reflects the new state.
              return chatResumeOtherSession(termId, sessionId, currentModel);
            })
            .catch((e) => {
              const msg = e instanceof Error ? e.message : String(e);
              dropMessage(`Rewind failed: ${msg}`);
            });
          return true;
        }
        case 'context':
        case 'compact':
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
    // termId is captured by handleSwitchModel but isn't a true dep —
    // we want this callback stable across re-renders that just bump
    // termId from null → real id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastTurn],
  );

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    const attachments = pendingAttachments;
    // Allow sending attachments-only (no text) — useful for "look at
    // this screenshot" flows. Block only when both are empty.
    if (!termId) return;
    if (!text && attachments.length === 0) return;
    setInput('');
    // Intercept client-side slash commands BEFORE shipping to claude
    // — otherwise claude wraps them in useless XML and the user sees
    // junk in the chat. Slash commands ignore any pending attachments.
    if (text.startsWith('/') && handleSlashCommand(text)) {
      return;
    }
    setBusy(true);
    forceScrollNextRef.current = true;
    // Light the working dot immediately — without this it stays idle
    // until claude's first event arrives (~1-2s of "is anything even
    // happening?" delay for the user).
    if (typeof agentId === 'number') {
      window.postMessage({ type: 'agentJsonlActivity', id: agentId }, '*');
    }
    // Build the user-bubble text. If there are attachments, list them
    // under the user's text so the bubble shows what was sent.
    const bubbleText =
      attachments.length === 0
        ? text
        : text
          ? `${text}\n${attachments.map((a) => `📎 ${a.name}`).join('\n')}`
          : attachments.map((a) => `📎 ${a.name}`).join('\n');
    setMessages((prev) => [
      ...prev,
      { kind: 'user', uid: uid(), ts: Date.now(), text: bubbleText },
    ]);
    setPendingAttachments([]);
    // If the background reaper killed claude after idle, the term_id is
    // gone from ChatManager — chat_send_user_text would error with "no
    // chat session". Respawn first (with --resume sessionId so the new
    // claude inherits the conversation), then send to the new term_id.
    let activeTermId = termId;
    if (idleRef.current) {
      try {
        const res = await chatSpawn({
          cwd,
          resume_session_id: sessionId,
          skip_permissions: skipPermissions ?? false,
          model: currentModel,
        });
        activeTermId = res.term_id;
        setTermId(res.term_id);
        if (res.session_id) setSessionId(res.session_id);
        onSessionReadyRef.current?.({ termId: res.term_id, sessionId: res.session_id });
        idleRef.current = false;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][ChatPane] respawn-on-resume failed', e);
        setError(msg);
        setBusy(false);
        return;
      }
    }
    try {
      if (attachments.length === 0) {
        await chatSendUserText(activeTermId, text);
      } else {
        await chatSendUserWithAttachments(
          activeTermId,
          text,
          attachments.map((a) => a.path),
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][ChatPane] send failed', e);
      setError(msg);
      setBusy(false);
      // On failure, restore attachments so the user can retry.
      setPendingAttachments(attachments);
    }
  }, [
    input,
    termId,
    handleSlashCommand,
    pendingAttachments,
    agentId,
    cwd,
    sessionId,
    skipPermissions,
    currentModel,
  ]);

  /** Stop the current turn — wired to both the Stop button and Ctrl+C
   *  (the same interrupt convention claude code's TUI uses). Optimistic
   *  UI: we drop a "⏹ stopping…" bubble + clear busy locally right
   *  away, then the real chat_exit handler upgrades it to "✓ turn
   *  stopped — session resumed" once the respawn lands. A 5s safety
   *  timer force-clears busy if exit never fires (e.g. claude hung in
   *  a tool that ate SIGINT). */
  const interruptTurn = useCallback((): void => {
    if (!termId) return;
    if (interruptingRef.current) {
      console.debug('[Deepthix][ChatPane] interrupt already in flight — ignored');
      return;
    }
    interruptingRef.current = true;
    interruptedRef.current = true;
    setMessages((prev) => [
      ...prev,
      {
        kind: 'system',
        uid: uid(),
        ts: Date.now(),
        subtype: 'exit',
        summary: '⏹ stopping turn…',
      },
    ]);
    // Clear busy locally for immediate UI feedback — the chat_exit
    // handler will set the final "stopped" message and set busy=false
    // again once the respawn completes.
    setBusy(false);
    // Safety timer: if no chat_exit arrives within 5s, something's
    // stuck. Surface it so the user isn't left wondering if Stop did
    // anything.
    if (interruptSafetyTimerRef.current) clearTimeout(interruptSafetyTimerRef.current);
    interruptSafetyTimerRef.current = setTimeout(() => {
      if (!interruptedRef.current) return; // exit already arrived
      console.warn('[Deepthix][ChatPane] interrupt timeout — no chat_exit after 5s');
      interruptedRef.current = false;
      interruptingRef.current = false;
      setMessages((prev) => [
        ...prev,
        {
          kind: 'system',
          uid: uid(),
          ts: Date.now(),
          subtype: 'exit',
          summary:
            '⚠ stop signal sent but claude did not exit (likely stuck in a tool). Try again or close the session.',
        },
      ]);
    }, 5000);
    void chatInterruptAndResume(termId, currentModel)
      .then(() => {
        // chat_exit handler will release interruptingRef.
        console.info('[Deepthix][ChatPane] interrupt+resume RPC ok — waiting for exit event');
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[Deepthix][ChatPane] interrupt+resume failed', e);
        interruptedRef.current = false;
        interruptingRef.current = false;
        if (interruptSafetyTimerRef.current) {
          clearTimeout(interruptSafetyTimerRef.current);
          interruptSafetyTimerRef.current = null;
        }
        setError(`Stop failed: ${msg}`);
      });
  }, [termId, currentModel]);

  // Ctrl+C global shortcut → stop the turn (same as claude code TUI).
  // Cmd+C is NOT touched (macOS native copy). On any platform, if the
  // user has an active text selection, we don't preventDefault — they
  // probably wanted to copy first.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!busy) return;
      if (e.key !== 'c' && e.key !== 'C') return;
      if (!e.ctrlKey || e.metaKey || e.altKey) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      e.preventDefault();
      console.info('[Deepthix][ChatPane] Ctrl+C → interrupt');
      interruptTurn();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, interruptTurn]);

  // Cleanup safety timer on unmount.
  useEffect(() => {
    return () => {
      if (interruptSafetyTimerRef.current) clearTimeout(interruptSafetyTimerRef.current);
    };
  }, []);

  const headerLabel = useMemo(
    () => (sessionId ? `claude · ${sessionId.slice(0, 8)}` : 'claude · starting…'),
    [sessionId],
  );

  /** Friendly model label for the header — strips the
   *  "claude-" prefix and the [1m] context-window suffix that's
   *  noisy in the chrome. Falls back to "?" when init hasn't fired. */
  const modelLabel = useMemo(() => {
    if (!currentModel) return null;
    return currentModel.replace(/^claude-/, '').replace(/\[[^\]]*\]$/, '');
  }, [currentModel]);

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

  // Seed the textarea up/down history with EVERY user message in the
  // current transcript — without this, ↑/↓ did nothing until the user
  // sent a fresh message in the current ChatInput mount, which made
  // it look like the arrow keys were broken on a reopened session.
  const userTextsForHistory = useMemo(() => {
    const out: string[] = [];
    for (const m of messages) {
      if (m.kind === 'user' && m.text) out.push(m.text);
    }
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
        // Distinct background for the focus zone — slight uplift over
        // --color-bg so the conversation reads as a stage separate
        // from the surrounding chrome (sidebar, top tabs, header).
        background: 'var(--color-bg-session)',
        fontFamily: 'var(--font-pixel)',
        color: 'var(--color-text)',
        // position: relative anchors the ModelPicker overlay's absolute
        // positioning to this pane (not the whole app).
        position: 'relative',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          background: 'var(--color-bg-dark)',
          borderBottom: '1px solid var(--color-border)',
          fontSize: '11px',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span
          title={cwd}
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {headerLabel}
          {/* Model badge — click to open the picker. Same effect as
              typing /model. Always present so the user knows what
              model the session is running on without needing to ask. */}
          <button
            type="button"
            onClick={() => setShowModelPicker(true)}
            disabled={!termId}
            title="Click to switch model + reasoning effort"
            style={{
              padding: '2px 8px',
              background: currentModel ? 'var(--color-accent)' : 'transparent',
              color: currentModel ? 'var(--color-bg-dark)' : 'inherit',
              border: '2px solid var(--color-border)',
              fontFamily: 'var(--font-pixel)',
              fontSize: 10,
              cursor: termId ? 'pointer' : 'default',
              letterSpacing: '0.04em',
              opacity: termId ? 1 : 0.4,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span>{modelLabel ?? '?'}</span>
            {currentEffort && (
              <span
                style={{
                  padding: '0 4px',
                  background: 'var(--color-bg-dark)',
                  color: 'var(--color-accent)',
                  fontWeight: 'bold',
                  letterSpacing: '0.06em',
                  fontSize: 9,
                }}
              >
                {currentEffort.toUpperCase()}
              </span>
            )}
          </button>
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

      {showModelPicker && termId && (
        <ModelPicker
          current={currentModel}
          currentEffort={currentEffort}
          onPick={(m, e) => {
            setShowModelPicker(false);
            // effort: '' means default (clears the flag); chatSwitchModel
            // accepts null for that semantic.
            const effortArg = e === '' ? null : e;
            setCurrentEffort(e || null);
            void chatSwitchModel(termId, m, effortArg)
              .then(() => {
                const effortLabel = e ? ` · effort=${e}` : '';
                setMessages((prev) => [
                  ...prev,
                  {
                    kind: 'system',
                    uid: uid(),
                    ts: Date.now(),
                    subtype: 'model',
                    summary: `Switched to ${m}${effortLabel}. Conversation context preserved.`,
                  },
                ]);
              })
              .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                setMessages((prev) => [
                  ...prev,
                  {
                    kind: 'error',
                    uid: uid(),
                    ts: Date.now(),
                    text: `Model switch failed: ${msg}`,
                  },
                ]);
              });
          }}
          onClose={() => setShowModelPicker(false)}
        />
      )}

      {showResumePicker && termId && (
        <ResumePickerPopup
          cwd={cwd}
          currentSessionId={sessionId}
          onPick={(picked) => {
            setShowResumePicker(false);
            setMessages((prev) => [
              ...prev,
              {
                kind: 'system',
                uid: uid(),
                ts: Date.now(),
                subtype: 'resume',
                summary: `Resuming session ${picked.session_id.slice(0, 8)} (${picked.user_turn_count} turns)…`,
              },
            ]);
            void chatResumeOtherSession(termId, picked.session_id, currentModel)
              .then(() => {
                setSessionId(picked.session_id);
                // The bound termId stays; tell ChatPane's effects to
                // re-hydrate the message log from the picked transcript.
                window.dispatchEvent(
                  new CustomEvent('deepthix:chat:resumed', {
                    detail: { termId, sessionId: picked.session_id },
                  }),
                );
              })
              .catch((e) => {
                const msg = e instanceof Error ? e.message : String(e);
                setError(`resume failed: ${msg}`);
              });
          }}
          onClose={() => setShowResumePicker(false)}
        />
      )}

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
            termId={termId}
          />
        ))}
        {/* "dernier message à HH:MM · il y a Xmin" badge under the last
         *  bubble when claude is no longer streaming. Lets the user
         *  glance and know whether the agent is still working or has
         *  been idle for a while — especially useful with the idle
         *  reaper around. Only shown when the chat is settled (not
         *  busy AND no pending placeholder) so it doesn't flicker
         *  in/out during streaming. */}
        {!busy && !showPendingPlaceholder && messages.length > 0 && (
          <LastMessageStamp ts={messages[messages.length - 1].ts} />
        )}
        {showPendingPlaceholder && <PendingPlaceholder />}
      </div>

      <ChatInput
        input={input}
        setInput={setInput}
        send={send}
        slashCommands={slashCommands}
        attachments={pendingAttachments}
        onRemoveAttachment={removeAttachment}
        historySeed={userTextsForHistory}
        // Always enabled once spawned. claude code in
        // --input-format=stream-json mode queues incoming user
        // turns — you can type a follow-up while the previous one is
        // still streaming and claude will pick it up after the
        // current turn ends.
        canSend={Boolean(termId)}
        spawning={!termId}
        busy={busy}
        onInterrupt={interruptTurn}
      />
    </div>
  );
}

// ─── Input + slash command autocomplete ─────────────────────────────────

// ─── Model picker ──────────────────────────────────────────────────────

interface ModelChoice {
  /** What we pass to claude --model. */
  id: string;
  /** Display name for the picker. */
  label: string;
  /** Short tagline shown under the name. */
  tagline: string;
}

const MODEL_CHOICES: ModelChoice[] = [
  {
    id: 'opus',
    label: 'Opus',
    tagline: 'Best reasoning · slowest · most expensive — for hard agentic work',
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    tagline: 'Balanced · ~3× faster than Opus · default for most tasks',
  },
  {
    id: 'haiku',
    label: 'Haiku',
    tagline: 'Fast & cheap · short answers · simple tool calls',
  },
];

/** Reasoning-effort levels claude code accepts via `--effort`.
 *  `default` clears the flag and lets claude pick. */
interface EffortChoice {
  id: string; // '' means default
  label: string;
  tagline: string;
}
const EFFORT_CHOICES: EffortChoice[] = [
  { id: '', label: 'Default', tagline: "claude picks based on the model" },
  { id: 'low', label: 'Low', tagline: 'Skip extended thinking · fastest' },
  { id: 'medium', label: 'Medium', tagline: 'Light thinking · default for most tasks' },
  { id: 'high', label: 'High', tagline: 'Deeper thinking · longer answers' },
  { id: 'xhigh', label: 'X-High', tagline: 'Heavy thinking · multi-step planning' },
  { id: 'max', label: 'Max', tagline: 'Ultrathink · burns tokens but goes deep' },
];

/**
 * Centered modal picker shown when the user types `/model` (no arg)
 * or clicks the model badge in the header. Pick a model → triggers
 * chat_switch_model on the session.
 */
function ModelPicker({
  current,
  currentEffort,
  onPick,
  onClose,
}: {
  current: string | null;
  /** Effort level claude is currently running with, or null if unset. */
  currentEffort: string | null;
  /** Fired when the user picks model + effort. effort = '' means
   *  "default", null only used internally. */
  onPick: (model: string, effort: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  // Local draft state so the user can pick model + effort then click
  // Apply (instead of triggering a respawn on each click). Pre-fills
  // from the live values.
  const initialModelId = useMemo(() => {
    const lower = current?.toLowerCase() ?? '';
    const match = MODEL_CHOICES.find((c) => lower.includes(c.id.toLowerCase()));
    return match?.id ?? 'sonnet';
  }, [current]);
  const [draftModel, setDraftModel] = useState<string>(initialModelId);
  const [draftEffort, setDraftEffort] = useState<string>(currentEffort ?? '');

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const isUnchanged =
    draftModel === initialModelId && draftEffort === (currentEffort ?? '');

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-dark)',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          padding: 18,
          maxWidth: 480,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          fontFamily: 'var(--font-pixel)',
          color: 'var(--color-text)',
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 'bold', letterSpacing: '0.05em' }}>
            Switch model & reasoning effort
          </div>
          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>
            Conversation context is preserved (--resume).
          </div>
        </div>

        {/* Model column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="dt-section-header" style={{ padding: 0 }}>
            Model
          </div>
          {MODEL_CHOICES.map((c) => {
            const isSelected = draftModel === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setDraftModel(c.id)}
                title={`Use ${c.label}`}
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  background: isSelected ? 'var(--color-bg)' : 'transparent',
                  color: 'inherit',
                  border: `2px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-pixel)',
                  fontSize: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  transition: 'border-color 120ms ease, background 120ms ease',
                }}
              >
                <span style={{ fontWeight: 'bold', fontSize: 13 }}>
                  {c.label}
                  {isSelected && (
                    <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--color-accent)' }}>
                      ✓
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 11, opacity: 0.75 }}>{c.tagline}</span>
              </button>
            );
          })}
        </div>

        {/* Effort column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="dt-section-header" style={{ padding: 0 }}>
            Reasoning effort
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {EFFORT_CHOICES.map((e) => {
              const isSelected = draftEffort === e.id;
              return (
                <button
                  key={e.id || 'default'}
                  type="button"
                  onClick={() => setDraftEffort(e.id)}
                  title={e.tagline}
                  style={{
                    padding: '6px 8px',
                    background: isSelected ? 'var(--color-bg)' : 'transparent',
                    color: 'inherit',
                    border: `2px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    cursor: 'pointer',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: 11,
                    fontWeight: isSelected ? 'bold' : 'normal',
                    transition: 'border-color 120ms ease, background 120ms ease',
                  }}
                >
                  {e.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 10, opacity: 0.7, lineHeight: 1.45 }}>
            {EFFORT_CHOICES.find((e) => e.id === draftEffort)?.tagline ?? ''}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} className="dt-btn" style={{ fontSize: 11 }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onPick(draftModel, draftEffort)}
            disabled={isUnchanged}
            className="dt-btn dt-btn--primary"
            style={{ fontSize: 11 }}
          >
            {isUnchanged ? 'No change' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatInput({
  input,
  setInput,
  send,
  slashCommands,
  attachments,
  onRemoveAttachment,
  historySeed,
  canSend,
  spawning,
  busy,
  onInterrupt,
}: {
  input: string;
  setInput: (v: string) => void;
  send: () => void;
  slashCommands: string[];
  attachments: PendingAttachment[];
  onRemoveAttachment: (uid: string) => void;
  /** Past sent messages from the loaded transcript — used to seed
   *  the up/down history navigation so the user doesn't have to
   *  re-type a fresh message before ↑/↓ does anything. */
  historySeed: string[];
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
  const [history, setHistory] = useState<string[]>(historySeed);
  // historySeed grows as the parent re-renders with new transcript
  // data. Keep history aligned with it, but only when we haven't
  // started archiving fresh sends (otherwise we'd clobber the user's
  // in-session history).
  const historyHasUserSendsRef = useRef(false);
  useEffect(() => {
    if (historyHasUserSendsRef.current) return;
    setHistory(historySeed);
  }, [historySeed]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [draftBeforeNav, setDraftBeforeNav] = useState<string>('');
  // Wrap `send` so we can capture into the history without leaking
  // that wiring into the parent.
  const sendAndArchive = useCallback((): void => {
    const text = input.trim();
    if (!text) return;
    historyHasUserSendsRef.current = true;
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
      'model',
      'resume',
      'rewind',
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
      {attachments.length > 0 && (
        <div
          style={{
            padding: '8px 12px 0',
            background: 'var(--color-bg-dark)',
            borderTop: '1px solid var(--color-border)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          {attachments.map((att) => (
            <AttachmentChip key={att.uid} att={att} onRemove={() => onRemoveAttachment(att.uid)} />
          ))}
        </div>
      )}
      <div
        style={{
          padding: '10px 12px',
          background: 'var(--color-bg-dark)',
          borderTop: attachments.length > 0 ? 'none' : '1px solid var(--color-border)',
          display: 'flex',
          gap: 8,
          flexShrink: 0,
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
            title="Stop the current turn (Ctrl+C)"
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
function AttachmentChip({
  att,
  onRemove,
}: {
  att: PendingAttachment;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: att.isImage ? 0 : '4px 8px',
        background: 'var(--color-bg)',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        maxWidth: 180,
        overflow: 'hidden',
        fontFamily: 'var(--font-pixel)',
        fontSize: 11,
      }}
      title={att.path}
    >
      {att.isImage && att.previewSrc ? (
        <img
          src={att.previewSrc}
          alt={att.name}
          style={{
            width: 64,
            height: 64,
            objectFit: 'cover',
            display: 'block',
          }}
        />
      ) : att.isImage ? (
        <div
          style={{
            width: 64,
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 0.5,
          }}
        >
          ⌛
        </div>
      ) : (
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 140,
          }}
        >
          📎 {att.name}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        title="Remove attachment"
        style={{
          position: 'absolute',
          top: 2,
          right: 2,
          width: 18,
          height: 18,
          background: 'var(--color-bg-dark)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border)',
          fontFamily: 'var(--font-pixel)',
          fontSize: 11,
          lineHeight: 1,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}

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

// memo: typing in the textarea re-renders ChatPane on every keystroke,
// which without memo re-runs every MessageBubble (and the heavy
// MarkdownBody underneath). Shallow-compare on props (m is a stable
// object reference for unchanged messages, running is a boolean) keeps
// existing bubbles untouched while typing — fixes the "ultra slow"
// composer perf user reported.
const MessageBubble = memo(MessageBubbleImpl);

/** Small footer rendered under the last message bubble when the chat
 *  is settled. Format: "dernier message à HH:MM · il y a 5 min".
 *  The relative-time half ticks every 30s so the user can tell at a
 *  glance how stale the conversation is — important context now that
 *  the idle reaper can silently kill a session in the background. */
function LastMessageStamp({ ts }: { ts: number }): React.JSX.Element {
  // Force a re-render every 30s so the "il y a Xmin" stays fresh
  // without anything else changing in the parent.
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const time = new Date(ts).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <div
      style={{
        opacity: 0.5,
        fontSize: 11,
        padding: '4px 12px 8px',
        textAlign: 'right',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      dernier message à {time} · {formatAgo(Date.now() - ts)}
    </div>
  );
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return "à l'instant";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `il y a ${h} h` : `il y a ${h} h ${m.toString().padStart(2, '0')}`;
}
function ResumePickerPopup({
  cwd,
  currentSessionId,
  onPick,
  onClose,
}: {
  cwd: string;
  currentSessionId: string | null;
  onPick: (s: ResumableSession) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [sessions, setSessions] = useState<ResumableSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listResumableSessions(cwd)
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720,
          maxWidth: '92%',
          maxHeight: '80%',
          background: 'var(--color-bg-dark)',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          fontFamily: 'var(--font-pixel)',
          color: 'var(--color-text)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '2px solid var(--color-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 'bold', letterSpacing: '0.06em' }}>
            /resume — pick a session
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '2px 10px',
              background: 'transparent',
              color: 'inherit',
              border: '1px solid var(--color-border)',
              fontFamily: 'var(--font-pixel)',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            ✗
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8 }}>
          {error && (
            <div style={{ padding: 12, color: 'var(--color-danger)', fontSize: 12 }}>{error}</div>
          )}
          {!error && !sessions && (
            <div style={{ padding: 12, opacity: 0.6, fontSize: 12 }}>Loading…</div>
          )}
          {!error && sessions && sessions.length === 0 && (
            <div style={{ padding: 12, opacity: 0.6, fontSize: 12 }}>
              No resumable sessions found in <code>{cwd}</code>.
            </div>
          )}
          {!error &&
            sessions?.map((s) => {
              const isCurrent = s.session_id === currentSessionId;
              return (
                <button
                  key={s.session_id}
                  type="button"
                  onClick={() => onPick(s)}
                  disabled={isCurrent}
                  title={isCurrent ? 'Already in this session' : 'Resume this session'}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    margin: '2px 0',
                    background: isCurrent ? 'var(--color-bg)' : 'transparent',
                    color: 'inherit',
                    border: '1px solid var(--color-border)',
                    cursor: isCurrent ? 'default' : 'pointer',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: 12,
                    opacity: isCurrent ? 0.6 : 1,
                    boxSizing: 'border-box',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 4,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'Menlo, Consolas, monospace',
                        fontSize: 11,
                        color: 'var(--color-accent)',
                      }}
                    >
                      {s.session_id.slice(0, 8)}
                    </span>
                    <span style={{ fontSize: 10, opacity: 0.55 }}>
                      {new Date(s.modified_ms).toLocaleString()}
                    </span>
                    <span style={{ fontSize: 10, opacity: 0.55 }}>
                      · {s.user_turn_count} turn{s.user_turn_count === 1 ? '' : 's'}
                    </span>
                    <span style={{ fontSize: 10, opacity: 0.55 }}>
                      · {(s.size_bytes / 1024).toFixed(1)} KB
                    </span>
                    {isCurrent && (
                      <span
                        style={{
                          marginLeft: 'auto',
                          fontSize: 10,
                          padding: '1px 6px',
                          background: 'var(--color-accent)',
                          color: 'var(--color-bg-dark)',
                          fontWeight: 'bold',
                        }}
                      >
                        CURRENT
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      opacity: 0.85,
                      lineHeight: 1.4,
                      maxHeight: 36,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {s.first_user_text || <em style={{ opacity: 0.6 }}>(no first user message)</em>}
                  </div>
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}

function MessageBubbleImpl({
  m,
  running,
  termId,
}: {
  m: Message;
  running?: boolean;
  termId: string | null;
}): React.JSX.Element {
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
      return <ToolBubble m={m} running={Boolean(running)} termId={termId} />;
    case 'system':
      return (
        <div
          className="dt-chat-msg"
          style={{
            alignSelf: 'center',
            fontSize: '11px',
            opacity: 0.7,
            padding: '6px 10px',
            border: '1px dashed var(--color-border)',
            // Multi-line system messages (notably /usage) need pre-wrap
            // so the \n separators we put between rows render as actual
            // line breaks rather than collapsing into one giant line.
            whiteSpace: 'pre-wrap',
            maxWidth: '90%',
            textAlign: 'left',
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

const Bubble = memo(BubbleImpl);
function BubbleImpl({
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
const MarkdownBody = memo(MarkdownBodyImpl);
function MarkdownBodyImpl({ source }: { source: string }): React.JSX.Element {
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

const ToolBubble = memo(ToolBubbleImpl);
function ToolBubbleImpl({
  m,
  running,
  termId,
}: {
  m: Extract<Message, { kind: 'tool_use' }>;
  running: boolean;
  termId: string | null;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isResult = m.tool === '(result)';
  const isAskUser = m.tool === 'AskUserQuestion';
  const style = useMemo(() => summarizeTool(m.tool, m.input), [m.tool, m.input]);

  // Auto-expand result bubbles since the result content IS the
  // information the user wants. Tool calls stay collapsed because
  // the summary is usually enough. AskUserQuestion auto-expands too
  // because the prompt UI lives inside the detail panel.
  const showDetail = expanded || isResult || (isAskUser && !m.result);

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
        {isAskUser && !m.result && (
          <AskUserPrompt
            input={m.input}
            toolUseId={m.toolUseId}
            termId={termId}
            inputPreviewShown={Boolean(inputPreview && expanded)}
          />
        )}
      </div>
    </div>
  );
}

/** Inline prompt for the AskUserQuestion tool. Without this the tool
 *  just hangs and claude eventually self-cancels with "Demande
 *  annulée". Parses the tool input defensively (the SDK schema has
 *  varied: sometimes {question, options}, sometimes {questions: [...]},
 *  sometimes plain text) and renders a button per option + a free-text
 *  fallback. On submit, fires chat_send_tool_result with the user's
 *  choice; the assistant's next turn picks up from there. */
function AskUserPrompt({
  input,
  toolUseId,
  termId,
  inputPreviewShown,
}: {
  input: unknown;
  toolUseId: string;
  termId: string | null;
  inputPreviewShown: boolean;
}): React.JSX.Element {
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [customText, setCustomText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Parse defensively. The SDK has shipped a few input shapes for
  // AskUserQuestion across versions:
  //   { question: "...", options: ["yes", "no"] }
  //   { question: "...", options: [{label, description}] }
  //   { questions: [{question, options}] }   // multi-question variant
  //   { prompt: "..." }                       // older alias
  //   "raw string"                            // fallback
  const { question, options } = useMemo(() => {
    const def = { question: 'The assistant is waiting for your input.', options: [] as string[] };
    if (input == null) return def;
    if (typeof input === 'string') return { question: input, options: [] };
    if (typeof input !== 'object') return def;
    const obj = input as Record<string, unknown>;
    // multi-question form: collapse to the first question for now
    const questionsArr = Array.isArray(obj.questions) ? obj.questions : null;
    if (questionsArr && questionsArr.length > 0 && typeof questionsArr[0] === 'object') {
      const q0 = questionsArr[0] as Record<string, unknown>;
      const qText =
        (q0.question as string) ||
        (q0.header as string) ||
        (q0.prompt as string) ||
        def.question;
      const opts = Array.isArray(q0.options)
        ? q0.options.map((o) => {
            if (typeof o === 'string') return o;
            if (o && typeof o === 'object') {
              const oo = o as Record<string, unknown>;
              return (oo.label as string) || (oo.value as string) || JSON.stringify(o);
            }
            return String(o);
          })
        : [];
      return { question: qText, options: opts };
    }
    const qText =
      (obj.question as string) || (obj.prompt as string) || (obj.header as string) || def.question;
    const opts = Array.isArray(obj.options)
      ? obj.options.map((o) => {
          if (typeof o === 'string') return o;
          if (o && typeof o === 'object') {
            const oo = o as Record<string, unknown>;
            return (oo.label as string) || (oo.value as string) || JSON.stringify(o);
          }
          return String(o);
        })
      : [];
    return { question: qText, options: opts };
  }, [input]);

  const send = useCallback(
    async (answer: string): Promise<void> => {
      if (!termId) {
        setError('Session not bound — cannot reply.');
        return;
      }
      if (submitting || submitted) return;
      setSubmitting(true);
      setError(null);
      try {
        await chatSendToolResult(termId, toolUseId, answer);
        setSubmitted(answer);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][AskUserPrompt] send failed', e);
        setError(msg);
      } finally {
        setSubmitting(false);
      }
    },
    [termId, toolUseId, submitting, submitted],
  );

  if (submitted) {
    return (
      <div
        style={{
          marginTop: inputPreviewShown ? 8 : 0,
          padding: '6px 10px',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          fontSize: 11,
          opacity: 0.85,
        }}
      >
        ✓ Réponse envoyée: <strong>{submitted}</strong>
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: inputPreviewShown ? 8 : 0,
        padding: '8px 10px',
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--color-text)' }}>{question}</div>
      {options.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="dt-btn"
              disabled={submitting}
              onClick={() => void send(opt)}
              style={{ fontSize: 11, padding: '4px 10px' }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      {/* Always offer Yes/No fallback when no options were supplied — this
          matches the screenshot the user saw where the assistant only
          knew it was supposed to "ask" but no schema had been provided. */}
      {options.length === 0 && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="dt-btn"
            disabled={submitting}
            onClick={() => void send('Yes')}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            Yes
          </button>
          <button
            type="button"
            className="dt-btn"
            disabled={submitting}
            onClick={() => void send('No')}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            No
          </button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && customText.trim()) {
              e.preventDefault();
              void send(customText.trim());
            }
          }}
          placeholder="Autre — réponse libre, ⏎ pour envoyer"
          disabled={submitting}
          style={{
            flex: 1,
            background: 'var(--color-bg-dark)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
            padding: '4px 8px',
            fontSize: 11,
            fontFamily: 'var(--font-pixel)',
          }}
        />
        <button
          type="button"
          className="dt-btn"
          disabled={submitting || !customText.trim()}
          onClick={() => void send(customText.trim())}
          style={{ fontSize: 11, padding: '4px 10px' }}
        >
          Envoyer
        </button>
      </div>
      {error && (
        <div style={{ fontSize: 11, color: 'var(--color-danger)' }}>Erreur: {error}</div>
      )}
    </div>
  );
}
