/* eslint-disable deepthix/no-inline-colors */
// USAGE section in the sidebar. Surfaces:
// - The Claude subscription tier (Max 20x, Pro, etc.) read from the macOS
//   keychain.
// - LIVE subscription limits fetched from the undocumented endpoint
//   `https://api.anthropic.com/api/oauth/usage` (the same one claude.ai
//   uses for its "Plan usage limits" panel). Three buckets:
//     • Current session (5h window)
//     • Weekly all-models
//     • Weekly Sonnet-only
//   Each renders as a tiny pixel progress bar with the % and the time
//   left until the bucket resets.
// - Today's local activity counts (messages, sessions) from
//   ~/.claude/stats-cache.json as a complementary local stat.

import { useCallback, useEffect, useState } from 'react';

import {
  type ClaudeActivity,
  type ClaudeSubscription,
  type ClaudeUsageLimits,
  openExternalUrl,
  readClaudeDailyActivity,
  readClaudeSubscription,
  readClaudeUsageLimits,
} from '../tauri/commands';

const POLL_MS = 60_000;
const COUNTDOWN_TICK_MS = 30_000;
const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';

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

/** "in 4h 12m" / "in 6d 3h" / "now" */
function formatResetCountdown(isoTs: string, nowMs: number): string {
  if (!isoTs) return '';
  const target = Date.parse(isoTs);
  if (Number.isNaN(target)) return '';
  const ms = target - nowMs;
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m > 0 ? `in ${hours}h ${m}m` : `in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `in ${days}d ${h}h` : `in ${days}d`;
}

function pctColor(pct: number): string {
  if (pct >= 0.85) return 'var(--color-danger)';
  if (pct >= 0.6) return 'var(--color-warning, #f59e0b)';
  return 'var(--color-status-success)';
}

export function UsagePane(): React.JSX.Element {
  const [sub, setSub] = useState<ClaudeSubscription | null>(null);
  const [activity, setActivity] = useState<ClaudeActivity | null>(null);
  const [limits, setLimits] = useState<ClaudeUsageLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, a, l] = await Promise.all([
        readClaudeSubscription(),
        readClaudeDailyActivity(),
        readClaudeUsageLimits(),
      ]);
      setSub(s);
      setActivity(a);
      setLimits(l);
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

  // Cheap local clock so the "in 4h 12m" reset countdown updates without
  // hitting the API every second.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, []);

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

          {/* Live subscription limits — the actual "Plan usage" panel. */}
          {limits && !limits.error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
              <UsageBar
                label="Session"
                bucket={limits.five_hour}
                now={now}
              />
              <UsageBar
                label="Weekly"
                bucket={limits.seven_day}
                now={now}
              />
              <UsageBar
                label="Sonnet wk"
                bucket={limits.seven_day_sonnet}
                now={now}
              />
            </div>
          )}
          {limits?.error && (
            <div
              style={{
                fontSize: '10px',
                opacity: 0.7,
                lineHeight: 1.4,
                color: 'var(--color-text-muted)',
              }}
              title={limits.error}
            >
              {limits.error.includes('cooldown') ? (
                <>refresh cooldown — relancing the auto-fetch in a few minutes</>
              ) : limits.error.includes('not signed in') ||
                limits.error.includes('invalid_grant') ||
                limits.error.includes('401') ? (
                <>
                  session expired — run <code>claude /login</code> in any terminal
                </>
              ) : (
                <>live limits unavailable</>
              )}
            </div>
          )}

          {activity && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '6px',
                marginTop: '6px',
                opacity: 0.85,
              }}
            >
              <span style={{ opacity: 0.7 }}>Today</span>
              <span>
                {formatNum(activity.today.message_count)} msg ·{' '}
                {formatNum(activity.today.session_count)} sess
              </span>
            </div>
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
            View on claude.ai →
          </button>
        </>
      )}
    </div>
  );
}

interface UsageBarProps {
  label: string;
  bucket: { utilization: number; resets_at: string };
  now: number;
}

function UsageBar({ label, bucket, now }: UsageBarProps): React.JSX.Element {
  const pct = Math.max(0, Math.min(1, bucket.utilization));
  const color = pctColor(pct);
  const countdown = formatResetCountdown(bucket.resets_at, now);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '11px',
        }}
      >
        <span style={{ opacity: 0.7 }}>{label}</span>
        <span style={{ color, fontWeight: 'bold' }}>{Math.round(pct * 100)}%</span>
      </div>
      <div
        style={{
          width: '100%',
          height: '6px',
          background: 'var(--color-bg-dark)',
          border: '1px solid var(--color-border)',
          position: 'relative',
        }}
      >
        <div
          style={{
            width: `${pct * 100}%`,
            height: '100%',
            background: color,
            transition: 'width 300ms ease-out',
          }}
        />
      </div>
      {countdown && (
        <div style={{ fontSize: '10px', opacity: 0.5 }}>resets {countdown}</div>
      )}
    </div>
  );
}
