// USAGE section in the sidebar (under FILES). Surfaces:
// - The Claude subscription tier (Max 20x, Pro, etc.) read from the macOS
//   keychain.
// - Today's local activity counts (messages, sessions, tool calls) read
//   from ~/.claude/stats-cache.json.
// - All-time totals from the same cache.
// - A button that opens claude.ai's usage page in the default browser
//   for the official "Plan usage limits" panel — there's no public API
//   to fetch that data, so the button is the most honest UX.

import { useCallback, useEffect, useState } from 'react';

import {
  type ClaudeActivity,
  type ClaudeSubscription,
  openExternalUrl,
  readClaudeDailyActivity,
  readClaudeSubscription,
} from '../tauri/commands';

const POLL_MS = 30_000;
const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';

/** Map "default_claude_max_20x" → "Max 20×" etc. */
function formatTier(sub: ClaudeSubscription): string {
  if (!sub.authenticated) return 'not signed in';
  const tier = sub.rate_limit_tier || sub.subscription_type;
  if (!tier) return sub.subscription_type || 'unknown';
  const match = tier.match(/(\d+)x/);
  const base = sub.subscription_type
    ? sub.subscription_type[0].toUpperCase() + sub.subscription_type.slice(1)
    : 'Plan';
  return match ? `${base} ${match[1]}×` : base;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function UsagePane(): React.JSX.Element {
  const [sub, setSub] = useState<ClaudeSubscription | null>(null);
  const [activity, setActivity] = useState<ClaudeActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, a] = await Promise.all([
        readClaudeSubscription(),
        readClaudeDailyActivity(),
      ]);
      setSub(s);
      setActivity(a);
      setError(null);
    } catch (e) {
      console.warn('[Deepthix][UsagePane] refresh failed', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const onOpenClaudeUsage = (): void => {
    void openExternalUrl(CLAUDE_USAGE_URL).catch((e) => {
      console.warn('[Deepthix][UsagePane] open claude.ai/settings/usage failed', e);
    });
  };

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

          {sub && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: '6px',
              }}
            >
              <span style={{ opacity: 0.7 }}>Plan</span>
              <span
                style={{
                  fontWeight: 'bold',
                  color: sub.authenticated
                    ? 'var(--color-accent-bright)'
                    : 'var(--color-text-muted)',
                }}
              >
                {formatTier(sub)}
              </span>
            </div>
          )}

          {activity && (
            <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '6px',
                  color: 'var(--color-accent-bright)',
                }}
              >
                <span style={{ opacity: 0.7 }}>Today</span>
                <span>
                  {formatNum(activity.today.message_count)} msg ·{' '}
                  {formatNum(activity.today.session_count)} sess
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '6px',
                  opacity: 0.85,
                }}
              >
                <span style={{ opacity: 0.7 }}>All time</span>
                <span>
                  {formatNum(activity.all_time.message_count)} msg ·{' '}
                  {formatNum(activity.all_time.tool_call_count)} tools
                </span>
              </div>
            </>
          )}

          <button
            type="button"
            onClick={onOpenClaudeUsage}
            title="Open the Plan usage limits page on claude.ai"
            style={{
              marginTop: '4px',
              padding: '4px 8px',
              background: 'transparent',
              color: 'inherit',
              border: '2px solid var(--color-border)',
              fontFamily: 'var(--font-pixel)',
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            View limits on claude.ai →
          </button>

          {activity?.last_computed_date && (
            <div style={{ fontSize: '10px', opacity: 0.45 }}>
              cache: {activity.last_computed_date}
            </div>
          )}
        </>
      )}
    </div>
  );
}
