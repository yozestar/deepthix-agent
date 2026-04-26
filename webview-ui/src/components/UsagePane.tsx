// USAGE section in the sidebar (under FILES). Surfaces total claude
// token consumption + estimated cost so the user can see at a glance
// how much they've burned today vs all-time.
//
// Polls the Rust `read_claude_usage` command every 30s. The command
// scans ~/.claude/projects/*/*.jsonl and aggregates by model — cheap
// even with hundreds of sessions because we only count `assistant`
// records.
//
// Cost estimation lives here (not in Rust) since pricing rates change
// faster than the Rust side wants to know about. The PRICING table
// below is the source of truth — update one place to refresh all
// numbers shown in the UI.

import { useCallback, useEffect, useState } from 'react';

import {
  type ClaudeUsage,
  type ModelUsage,
  readClaudeUsage,
} from '../tauri/commands';

/**
 * Per-model pricing (USD per million tokens). Cache pricing follows
 * Anthropic's standard multipliers (creation = 1.25× input, read = 0.1×
 * input). If the model name doesn't match an entry here, we fall back
 * to the `default` row — the user still sees raw token counts.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  default: { input: 3, output: 15 },
};

const POLL_MS = 30_000;

interface ModelLine {
  model: string;
  costUsd: number;
  totalTokens: number;
}

function pricingFor(model: string): { input: number; output: number } {
  return PRICING[model] ?? PRICING.default;
}

/** USD cost for a single model bucket — input + output + cache pricing. */
function costFor(model: string, u: ModelUsage): number {
  const rate = pricingFor(model);
  const inputCost = (u.input_tokens / 1_000_000) * rate.input;
  const outputCost = (u.output_tokens / 1_000_000) * rate.output;
  // Cache creation = 1.25× input rate, cache read = 0.1× input rate
  // (Anthropic's standard prompt-caching multipliers).
  const cacheWriteCost = (u.cache_creation_input_tokens / 1_000_000) * rate.input * 1.25;
  const cacheReadCost = (u.cache_read_input_tokens / 1_000_000) * rate.input * 0.1;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

function summarize(buckets: Record<string, ModelUsage>): {
  totalCost: number;
  totalTokens: number;
  byModel: ModelLine[];
} {
  let totalCost = 0;
  let totalTokens = 0;
  const byModel: ModelLine[] = [];
  for (const [model, u] of Object.entries(buckets)) {
    const cost = costFor(model, u);
    const tokens =
      u.input_tokens +
      u.output_tokens +
      u.cache_creation_input_tokens +
      u.cache_read_input_tokens;
    totalCost += cost;
    totalTokens += tokens;
    byModel.push({ model, costUsd: cost, totalTokens: tokens });
  }
  byModel.sort((a, b) => b.costUsd - a.costUsd);
  return { totalCost, totalTokens, byModel };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

/** Short, friendly model name for display (drops the `claude-` prefix). */
function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function UsagePane(): React.JSX.Element {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const u = await readClaudeUsage();
      setUsage(u);
      setError(null);
    } catch (e) {
      console.warn('[Deepthix][UsagePane] read failed', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const today = usage ? summarize(usage.today) : null;
  const all = usage ? summarize(usage.all_time) : null;

  return (
    <div
      style={{
        borderTop: '2px solid var(--color-border)',
        padding: '8px 10px',
        fontFamily: 'var(--font-pixel)',
        fontSize: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          opacity: 0.8,
          letterSpacing: '0.06em',
        }}
        title="Click to collapse / expand"
      >
        <span>USAGE</span>
        <span style={{ fontSize: '10px', opacity: 0.6 }}>{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <>
          {error && (
            <div style={{ color: 'var(--color-danger)', fontSize: '11px' }}>{error}</div>
          )}
          {!usage && !error && (
            <div style={{ opacity: 0.5, fontSize: '11px' }}>loading…</div>
          )}
          {usage && today && all && (
            <>
              <Line label="Today" cost={today.totalCost} tokens={today.totalTokens} bright />
              <Line label="All time" cost={all.totalCost} tokens={all.totalTokens} />
              {all.byModel.length > 0 && (
                <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {all.byModel.slice(0, 4).map((m) => (
                    <div
                      key={m.model}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '6px',
                        fontSize: '11px',
                        opacity: 0.7,
                      }}
                      title={`${m.model} — ${m.totalTokens.toLocaleString()} tokens`}
                    >
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                        }}
                      >
                        {shortModel(m.model)}
                      </span>
                      <span>{formatUsd(m.costUsd)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ fontSize: '10px', opacity: 0.45, marginTop: '2px' }}>
                {usage.session_count} session{usage.session_count === 1 ? '' : 's'} · est.
                cost
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

interface LineProps {
  label: string;
  cost: number;
  tokens: number;
  bright?: boolean;
}

function Line({ label, cost, tokens, bright }: LineProps): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: '8px',
        color: bright ? 'var(--color-accent-bright)' : 'inherit',
      }}
    >
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ fontWeight: bright ? 'bold' : 'normal' }}>
        {formatUsd(cost)} <span style={{ opacity: 0.5, fontSize: '10px' }}>· {formatTokens(tokens)}</span>
      </span>
    </div>
  );
}
