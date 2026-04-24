/**
 * Subset of pixel-agents transcript parser. Reads one JSONL record (already
 * raw text) and returns 0..n window-message-event payloads for the office
 * canvas to consume via `useExtensionMessages`.
 *
 * Records of interest (heuristic mode, no hooks):
 *  - `assistant` with content[].type === 'tool_use'   → agentToolStart
 *  - `user`      with content[].type === 'tool_result' → agentToolDone
 *  - `system`    with subtype === 'turn_duration'      → agentToolClear (turn end)
 *
 * Unknown record types are ignored safely.
 */

interface AssistantToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

interface UserToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
}

interface AssistantRecord {
  type: 'assistant';
  message?: { content?: AssistantToolUseBlock[] };
}

interface UserRecord {
  type: 'user';
  message?: { content?: UserToolResultBlock[] | string };
}

interface SystemRecord {
  type: 'system';
  subtype?: string;
}

type TranscriptRecord = AssistantRecord | UserRecord | SystemRecord | { type: string };

export interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

export function parseRecord(agentId: number, raw: string): WebviewMessage[] {
  let record: TranscriptRecord;
  try {
    record = JSON.parse(raw) as TranscriptRecord;
  } catch (err) {
    console.debug('[Deepthix][transcriptParser] JSON parse error', err);
    return [];
  }

  const out: WebviewMessage[] = [];

  if (record.type === 'assistant') {
    const r = record as AssistantRecord;
    const blocks = r.message?.content ?? [];
    if (!Array.isArray(blocks)) return out;
    for (const block of blocks) {
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        console.debug('[Deepthix][transcriptParser] tool_use', {
          agentId,
          toolId: block.id,
          toolName: block.name,
        });
        out.push({
          type: 'agentToolStart',
          agentId,
          toolId: block.id,
          toolName: block.name,
        });
      }
    }
  } else if (record.type === 'user') {
    const r = record as UserRecord;
    const content = r.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && block.type === 'tool_result') {
          console.debug('[Deepthix][transcriptParser] tool_result', {
            agentId,
            toolId: block.tool_use_id,
          });
          out.push({
            type: 'agentToolDone',
            agentId,
            toolId: block.tool_use_id,
          });
        }
      }
    }
  } else if (record.type === 'system') {
    const r = record as SystemRecord;
    if (r.subtype === 'turn_duration') {
      console.debug('[Deepthix][transcriptParser] turn_duration → clear', { agentId });
      out.push({ type: 'agentToolClear', agentId });
    }
  }

  return out;
}
