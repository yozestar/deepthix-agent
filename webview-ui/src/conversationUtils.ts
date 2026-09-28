// Pure helpers for the conversation sidebar and chat turn footers. Kept
// free of React / Tauri imports so they can be unit-tested under node.

import { AVATAR_COLORS } from './constants';

/** Two-letter initials: first letters of the first two words, else the
 *  first two characters. */
export function initials(name: string): string {
  const words = name
    .replace(/[_\-.]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

/** Stable palette pick from an id (djb2 hash). */
export function avatarColor(id: string): string {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

/** "15:23" today, "hier", "ven." within a week, else "12/09". */
export function formatWhen(ms: number, now: number = Date.now()): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday) {
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  const dayMs = 86_400_000;
  if (ms >= startOfToday - dayMs) return 'hier';
  if (ms >= startOfToday - 6 * dayMs) return d.toLocaleDateString('fr-FR', { weekday: 'short' });
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

/** Case- and accent-insensitive "contains". */
export function matches(haystack: string, needle: string): boolean {
  const norm = (s: string): string =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return norm(haystack).includes(norm(needle));
}

export interface TurnInfo {
  /** Wall time from the user message to the last message of the turn. */
  durationMs: number;
  /** Tool calls made during the turn (results not counted). */
  tools: number;
  /** Timestamp of the last message of the turn. */
  endTs: number;
}

/** Map "index of the last message of a turn" → footer info. Exported for
 *  tests. A turn starts at a user message; turns without any assistant
 *  output (e.g. still waiting) get no footer. */
export function computeTurnFooters(
  messages: ReadonlyArray<{ kind: string; ts: number; tool?: string }>,
): Map<number, TurnInfo> {
  const out = new Map<number, TurnInfo>();
  let start = -1;
  const close = (end: number): void => {
    if (start < 0 || end <= start) return;
    let tools = 0;
    let replied = false;
    for (let j = start + 1; j <= end; j++) {
      const m = messages[j];
      if (m.kind === 'assistant_text') replied = true;
      if (m.kind === 'tool_use' && m.tool !== '(result)') tools++;
    }
    if (!replied && tools === 0) return;
    out.set(end, {
      durationMs: Math.max(0, messages[end].ts - messages[start].ts),
      tools,
      endTs: messages[end].ts,
    });
  };
  messages.forEach((m, i) => {
    if (m.kind === 'user') {
      close(i - 1);
      start = i;
    }
  });
  close(messages.length - 1);
  return out;
}


// ── Context gauge ──────────────────────────────────────────────────────
// Same rule as pixel-agents (contextWindowForModel): Haiku and the older
// model lines run a 200k window, every current model 1M. Transcripts state
// usage but never the limit, so the window is inferred from the model id.
export const LARGE_CONTEXT_WINDOW = 1_000_000;
export const SMALL_CONTEXT_WINDOW = 200_000;
const SMALL_CONTEXT_MODEL_PATTERN = /haiku|claude-[123]|-4-[01]\b/i;

export function contextWindowForModel(model: string | null | undefined): number {
  if (model && SMALL_CONTEXT_MODEL_PATTERN.test(model)) return SMALL_CONTEXT_WINDOW;
  return LARGE_CONTEXT_WINDOW;
}

/** Context occupancy carried by one assistant record: the newest turn's
 *  prompt (incl. cache reads/writes) + its output. A snapshot, not a
 *  running total — it drops when a session is compacted or cleared.
 *  Sub-agent records (sidechain / parent_tool_use_id) don't count: they
 *  live in their own context. */
export function contextFromRecord(
  obj: Record<string, unknown>,
): { tokens: number; model: string | null } | null {
  if (obj.type !== 'assistant') return null;
  if (obj.isSidechain === true || obj.parent_tool_use_id) return null;
  const msg = obj.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, unknown> | undefined;
  if (!usage) return null;
  const n = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
  const tokens =
    n('input_tokens') +
    n('cache_read_input_tokens') +
    n('cache_creation_input_tokens') +
    n('output_tokens');
  if (tokens <= 0) return null;
  return { tokens, model: typeof msg?.model === 'string' ? (msg.model as string) : null };
}

/** Lowercase + strip accents one char at a time, so indices in the folded
 *  string match indices in the original (unlike a whole-string NFD pass). */
function foldChars(s: string): string {
  let out = '';
  for (const ch of s) out += (ch.normalize('NFD')[0] ?? ch).toLowerCase();
  return out;
}

/** [before, match, after] split of `text` on the first accent/case-
 *  insensitive occurrence of `query`; null when absent. */
export function splitOnMatch(text: string, query: string): [string, string, string] | null {
  const q = foldChars(query.trim());
  if (!q) return null;
  const chars = [...text];
  const folded = [...foldChars(text)];
  const qc = [...q];
  for (let i = 0; i + qc.length <= folded.length; i++) {
    let ok = true;
    for (let j = 0; j < qc.length; j++) {
      if (folded[i + j] !== qc[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return [
        chars.slice(0, i).join(''),
        chars.slice(i, i + qc.length).join(''),
        chars.slice(i + qc.length).join(''),
      ];
    }
  }
  return null;
}
