/* eslint-disable deepthix/no-inline-colors */
// USAGE section in the sidebar.
//
// Primary source: the statusline-dumper snapshot at
// ~/.deepthix/usage-snapshot.json. Claude code pipes a JSON blob with
// { rate_limits, cost, context_window, model, ... } to its statusLine
// command on every UI tick; we install a tiny shell script as that
// command (in src-tauri/src/commands/usage_snapshot.rs) so the JSON
// lands on disk. As long as at least one Deepthix-spawned claude
// session is running, this gives us live data with no OAuth, no
// Cloudflare, no rate limits.
//
// Fallback display: subscription tier from the keychain + daily activity
// from claude's local stats-cache. Shown when the snapshot is missing
// or stale (no active session).

import { useCallback, useEffect, useState } from 'react';

import {
  type ClaudeActivity,
  type ClaudeSubscription,
  type ClaudeUsageLimits,
  openExternalUrl,
  readClaudeDailyActivity,
  readClaudeSubscription,
  readClaudeUsageLimits,
  readClaudeUsageSnapshot,
} from '../tauri/commands';

/**
 * Convert the OAuth `read_claude_usage_limits` shape (utilization
 * fraction + ISO resets_at) into the snapshot RateLimitBucket shape
 * the UsageBar already speaks. Returns null when the OAuth payload
 * carried an error (typically HTTP 429 / no auth) — caller falls
 * through to "limits unavailable".
 */
// Friendly display names for the bucket keys the API has been seen
// emitting. Anything not in this map gets rendered with a humanized
// version of the raw key — better than dropping it on the floor.
const BUCKET_LABELS: Record<string, string> = {
  five_hour: 'Session 5h',
  current_session: 'Session 5h',
  session: 'Session 5h',
  session_5h: 'Session 5h',
  seven_day: 'Weekly',
  weekly: 'Weekly',
  all_models_weekly: 'Weekly',
  seven_day_all_models: 'Weekly',
  seven_day_sonnet: 'Sonnet wk',
  sonnet_weekly: 'Sonnet wk',
  weekly_sonnet: 'Sonnet wk',
  seven_day_opus: 'Opus wk',
  opus_weekly: 'Opus wk',
  claude_design: 'Claude Design',
  claude_design_weekly: 'Claude Design',
};

function humanizeBucketKey(key: string): string {
  if (BUCKET_LABELS[key]) return BUCKET_LABELS[key];
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function oauthLimitsToBuckets(
  oauth: ClaudeUsageLimits | null,
):
  | {
      five_hour?: RateLimitBucket;
      seven_day?: RateLimitBucket;
      seven_day_sonnet?: RateLimitBucket;
      seven_day_opus?: RateLimitBucket;
    }
  | undefined {
  if (!oauth || oauth.error) return undefined;
  const toBucket = (b: { utilization: number; resets_at: string }): RateLimitBucket => {
    const ms = Date.parse(b.resets_at);
    return {
      used_percentage: Math.round(b.utilization * 100),
      resets_at: Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined,
    };
  };
  // Build the canonical four. Prefer the structured Rust-side picks
  // (five_hour / seven_day / seven_day_sonnet) since Rust already tried
  // multiple candidate keys; fall back to all_buckets for opus + any
  // alt-spelled key the picker missed.
  const out: {
    five_hour?: RateLimitBucket;
    seven_day?: RateLimitBucket;
    seven_day_sonnet?: RateLimitBucket;
    seven_day_opus?: RateLimitBucket;
  } = {};
  if (oauth.five_hour && oauth.five_hour.utilization > 0) {
    out.five_hour = toBucket(oauth.five_hour);
  }
  if (oauth.seven_day && oauth.seven_day.utilization > 0) {
    out.seven_day = toBucket(oauth.seven_day);
  }
  if (oauth.seven_day_sonnet && oauth.seven_day_sonnet.utilization > 0) {
    out.seven_day_sonnet = toBucket(oauth.seven_day_sonnet);
  }
  // Backfill from all_buckets if the structured pick was empty (zero).
  // Lots of zeroes in the pickers usually means the API renamed the
  // keys and Rust's candidate list missed one — surface what's actually
  // there instead of pretending everything is at 0%.
  const all = oauth.all_buckets ?? {};
  if (!out.five_hour) {
    for (const k of Object.keys(all)) {
      if (/(five.?hour|current.?session|session)/i.test(k) && all[k].utilization > 0) {
        out.five_hour = toBucket(all[k]);
        break;
      }
    }
  }
  if (!out.seven_day) {
    for (const k of Object.keys(all)) {
      if (/(seven.?day|weekly|all.?models)/i.test(k) && !/sonnet|opus|design/i.test(k) && all[k].utilization > 0) {
        out.seven_day = toBucket(all[k]);
        break;
      }
    }
  }
  if (!out.seven_day_sonnet) {
    for (const k of Object.keys(all)) {
      if (/sonnet/i.test(k) && all[k].utilization > 0) {
        out.seven_day_sonnet = toBucket(all[k]);
        break;
      }
    }
  }
  for (const k of Object.keys(all)) {
    if (/opus/i.test(k) && all[k].utilization > 0) {
      out.seven_day_opus = toBucket(all[k]);
      break;
    }
  }
  // If everything is still empty, return undefined so the source
  // resolver falls through to the cached/none branch.
  if (
    !out.five_hour &&
    !out.seven_day &&
    !out.seven_day_sonnet &&
    !out.seven_day_opus &&
    Object.keys(all).length === 0
  ) {
    return undefined;
  }
  return out;
}

/** Buckets returned by the API that don't match our four canonical
 *  slots (e.g., new "claude_design_weekly" surfaced after the API
 *  added the bucket). Caller renders these as extra rows so we don't
 *  drop server data on the floor. */
// Hide buckets the API returns that aren't useful in the pane:
//   - extra_usage: not a rate limit bucket — it's a separate billing
//     concept the user can't act on from this view.
//   - seven_day_omelette: parser harvested it from a nested non-bucket
//     object that happens to have a utilization-shaped field. Noise.
//   - sonnet/opus naming variants we already render as canonical.
const HIDDEN_EXTRA_BUCKETS = new Set([
  'extra_usage',
  'seven_day_omelette',
]);

function extraBuckets(oauth: ClaudeUsageLimits | null): { key: string; label: string; bucket: RateLimitBucket }[] {
  if (!oauth || oauth.error || !oauth.all_buckets) return [];
  const known = new Set([
    'five_hour',
    'current_session',
    'session',
    'session_5h',
    'seven_day',
    'weekly',
    'all_models_weekly',
    'seven_day_all_models',
    'seven_day_sonnet',
    'sonnet_weekly',
    'weekly_sonnet',
    'seven_day_opus',
    'opus_weekly',
  ]);
  const toBucket = (b: { utilization: number; resets_at: string }): RateLimitBucket => {
    const ms = Date.parse(b.resets_at);
    return {
      used_percentage: Math.round(b.utilization * 100),
      resets_at: Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined,
    };
  };
  const out: { key: string; label: string; bucket: RateLimitBucket }[] = [];
  for (const [key, value] of Object.entries(oauth.all_buckets)) {
    if (known.has(key)) continue;
    if (HIDDEN_EXTRA_BUCKETS.has(key)) continue;
    out.push({ key, label: humanizeBucketKey(key), bucket: toBucket(value) });
  }
  return out;
}

const POLL_MS = 5_000;
const COUNTDOWN_TICK_MS = 30_000;
const SNAPSHOT_STALE_MS = 5 * 60 * 1000; // 5 min → snapshot considered live
const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';
// Persist the most recently observed limits + timestamp so the pane
// can fall back to "last known" instead of going blank when both the
// snapshot is stale AND the OAuth endpoint is rate-limited / down.
// User explicitly asked for this — they'd rather see a 4h-old reading
// than "limits unavailable" with nothing useful to act on.
const LAST_LIMITS_STORAGE_KEY = 'deepthix.usage.lastLimits';

interface CachedLimits {
  ts: number;
  source: 'snapshot' | 'oauth';
  limits: {
    five_hour?: RateLimitBucket;
    seven_day?: RateLimitBucket;
    seven_day_sonnet?: RateLimitBucket;
    seven_day_opus?: RateLimitBucket;
  };
  /** Every raw bucket the API returned. Cached so the debug panel
   *  works even when the live OAuth call is down. */
  allBuckets?: Record<string, { utilization: number; resets_at: string }>;
}

function readCachedLimits(): CachedLimits | null {
  try {
    const raw = localStorage.getItem(LAST_LIMITS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedLimits;
    if (!parsed || typeof parsed.ts !== 'number' || !parsed.limits) return null;
    return parsed;
  } catch (e) {
    console.warn('[Deepthix][UsagePane] cached limits parse failed', e);
    return null;
  }
}

function writeCachedLimits(c: CachedLimits): void {
  try {
    localStorage.setItem(LAST_LIMITS_STORAGE_KEY, JSON.stringify(c));
    console.debug('[Deepthix][UsagePane] cached limits written', { source: c.source, ts: c.ts });
  } catch (e) {
    console.warn('[Deepthix][UsagePane] cached limits write failed', e);
  }
}

/** "2m ago" / "1h 14m ago" / "3d ago" — input is epoch ms (in the past). */
function formatTimeAgo(tsMs: number, nowMs: number): string {
  const ms = nowMs - tsMs;
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m > 0 ? `${hours}h ${m}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface RateLimitBucket {
  used_percentage?: number;
  resets_at?: number; // epoch seconds
}

interface ParsedSnapshot {
  rate_limits?: {
    five_hour?: RateLimitBucket;
    seven_day?: RateLimitBucket;
    seven_day_sonnet?: RateLimitBucket;
    seven_day_opus?: RateLimitBucket;
  };
  cost?: {
    total_cost_usd?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    used_percentage?: number;
    context_window_size?: number;
  };
  model?: { display_name?: string };
}

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

function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

/** "in 4h 12m" / "in 6d 3h" / "now" — input is epoch seconds. */
function formatResetCountdown(epochSec: number, nowMs: number): string {
  if (!epochSec) return '';
  const ms = epochSec * 1000 - nowMs;
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
  if (pct >= 85) return 'var(--color-danger)';
  if (pct >= 60) return 'var(--color-warning, #f59e0b)';
  return 'var(--color-status-success)';
}

function parseSnapshot(body: string): ParsedSnapshot | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as ParsedSnapshot;
  } catch (e) {
    console.warn('[Deepthix][UsagePane] snapshot parse failed', e);
    return null;
  }
}

export function UsagePane(): React.JSX.Element {
  const [sub, setSub] = useState<ClaudeSubscription | null>(null);
  const [activity, setActivity] = useState<ClaudeActivity | null>(null);
  const [snapshot, setSnapshot] = useState<ParsedSnapshot | null>(null);
  const [snapshotMtime, setSnapshotMtime] = useState<number>(0);
  const [oauthLimits, setOauthLimits] = useState<ClaudeUsageLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, a, snap] = await Promise.all([
        readClaudeSubscription(),
        readClaudeDailyActivity(),
        readClaudeUsageSnapshot(),
      ]);
      setSub(s);
      setActivity(a);
      setSnapshot(parseSnapshot(snap.body));
      setSnapshotMtime(snap.mtime_ms);
      setError(null);
    } catch (e) {
      console.warn('[Deepthix][UsagePane] refresh failed', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // OAuth-based live limits — fallback when no statusLine snapshot
  // (chat sessions don't emit statusLine because they're --print
  // mode, not TUI). Polled less aggressively because the endpoint
  // gets HTTP-429'd if hammered.
  const refreshOauth = useCallback(async (): Promise<void> => {
    try {
      const lim = await readClaudeUsageLimits();
      setOauthLimits(lim);
    } catch (e) {
      console.debug('[Deepthix][UsagePane] OAuth limits poll failed', e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    void refreshOauth();
    // 90s — slow enough to stay below the OAuth endpoint's rate limit,
    // fast enough to feel live for the user.
    const id = setInterval(() => void refreshOauth(), 90_000);
    return () => clearInterval(id);
  }, [refreshOauth]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const onOpenClaudeUsage = (): void => {
    void openExternalUrl(CLAUDE_USAGE_URL).catch((e) => {
      console.warn('[Deepthix][UsagePane] open claude.ai/settings/usage failed', e);
    });
  };

  // Toggle to expose every bucket the API returned, for debugging
  // mismatches with claude.ai's official panel ("Sonnet wk shows 100%
  // here but 1% on claude.ai" → which API key is actually at 100%?).
  const [debugAllBuckets, setDebugAllBuckets] = useState(false);

  const snapshotFresh = snapshotMtime > 0 && now - snapshotMtime < SNAPSHOT_STALE_MS;
  // Resolve live limits: prefer fresh snapshot data, else OAuth. We
  // can't bind the source to "snapshot is fresh" alone — chat-mode
  // sessions write a snapshot WITHOUT rate_limits (the JSON is from
  // statusLine which only the TUI emits), so a fresh snapshot can
  // still be empty for our purposes. Pick whichever path actually
  // produced bucket data.
  const snapshotLimits = snapshotFresh ? snapshot?.rate_limits : undefined;
  const oauthLimitsBuckets = oauthLimitsToBuckets(oauthLimits);
  const liveLimits = snapshotLimits ?? oauthLimitsBuckets;
  const liveSource: 'snapshot' | 'oauth' | 'none' = snapshotLimits
    ? 'snapshot'
    : oauthLimitsBuckets
      ? 'oauth'
      : 'none';

  // Persist whatever live limits we just fetched, so a future "no
  // data" render can fall back to them instead of showing nothing.
  useEffect(() => {
    if (liveSource === 'none' || !liveLimits) return;
    writeCachedLimits({
      ts: Date.now(),
      source: liveSource,
      limits: liveLimits,
      allBuckets: oauthLimits?.all_buckets,
    });
  }, [liveLimits, liveSource, oauthLimits?.all_buckets]);

  // When live data is missing, surface the last cached reading so the
  // user still sees their most recent percentages (and an "Xh ago"
  // tag). Read once on mount + whenever the live source changes.
  const [cachedLimits, setCachedLimits] = useState<CachedLimits | null>(() => readCachedLimits());
  useEffect(() => {
    if (liveSource !== 'none') return;
    setCachedLimits(readCachedLimits());
  }, [liveSource]);

  const limits = liveLimits ?? cachedLimits?.limits;
  const limitsSource: 'snapshot' | 'oauth' | 'cached' | 'none' =
    liveSource !== 'none' ? liveSource : cachedLimits ? 'cached' : 'none';

  // Visibility into why "none" — useful when the user reports "ca marche
  // pas" and we need to know which side failed.
  useEffect(() => {
    console.debug('[Deepthix][UsagePane] resolved', {
      snapshotMtime,
      snapshotFresh,
      hasSnapshotLimits: !!snapshotLimits,
      hasOauthLimits: !!oauthLimitsBuckets,
      oauthError: oauthLimits?.error ?? null,
      liveSource,
      limitsSource,
      cachedAt: cachedLimits?.ts ?? null,
    });
  }, [
    snapshotMtime,
    snapshotFresh,
    snapshotLimits,
    oauthLimitsBuckets,
    oauthLimits?.error,
    liveSource,
    limitsSource,
    cachedLimits?.ts,
  ]);
  const totalCostUsd = snapshot?.cost?.total_cost_usd ?? 0;
  const ctxPct = snapshot?.context_window?.used_percentage ?? 0;

  return (
    <div
      style={{
        borderTop: '1px solid var(--color-border)',
        padding: '6px 10px 10px',
        fontFamily: 'var(--font-pixel)',
        fontSize: '0.75rem',
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
        className="dt-section-header"
        style={{
          cursor: 'pointer',
          padding: '6px 0 4px',
        }}
        title="Click to collapse / expand"
      >
        <span>Usage</span>
        <span style={{ fontSize: '0.625rem', opacity: 0.55 }}>{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <>
          {error && (
            <div style={{ color: 'var(--color-danger)', fontSize: '0.6875rem' }}>{error}</div>
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

          {/* Live limit bars — snapshot first (richer, includes opus
              breakdown), OAuth fallback otherwise. Plus any extra
              buckets the API surfaced after our schema (e.g.
              "Claude Design") so we never silently drop server data. */}
          {limits && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
              {limits.five_hour && (
                <UsageBar label="Session 5h" bucket={limits.five_hour} now={now} />
              )}
              {limits.seven_day && (
                <UsageBar label="Weekly" bucket={limits.seven_day} now={now} />
              )}
              {/* Sonnet wk hidden — the API key the picker chose was
                  reading 100% while claude.ai showed 1%; user asked to
                  drop the row until the bucket-key mismatch is fixed. */}
              {limits.seven_day_opus && (
                <UsageBar label="Opus wk" bucket={limits.seven_day_opus} now={now} />
              )}
              {extraBuckets(oauthLimits).map((extra) => (
                <UsageBar
                  key={extra.key}
                  label={extra.label}
                  bucket={extra.bucket}
                  now={now}
                />
              ))}
            </div>
          )}
          {limitsSource === 'oauth' && (
            <div style={{ fontSize: '0.5625rem', opacity: 0.45, lineHeight: 1.4 }}>
              live from claude.ai/api/oauth/usage
            </div>
          )}
          {/* Debug toggle: always rendered when the pane is open.
              Forces a fresh OAuth fetch on click so the dump shows
              current data even when the cached entry is stale (or was
              written before all_buckets was cached). */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => {
                const next = !debugAllBuckets;
                setDebugAllBuckets(next);
                if (next) {
                  // Force a refresh so we don't show stale "no buckets"
                  // when oauth has been down for a while.
                  void refreshOauth();
                  const src = oauthLimits?.all_buckets ?? cachedLimits?.allBuckets ?? {};
                  console.info(
                    '[Deepthix][UsagePane] all buckets dump',
                    Object.fromEntries(
                      Object.entries(src).map(([k, v]) => [k, `${(v.utilization * 100).toFixed(1)}%`]),
                    ),
                    { canonical: { five_hour: oauthLimits?.five_hour, seven_day: oauthLimits?.seven_day, seven_day_sonnet: oauthLimits?.seven_day_sonnet } },
                  );
                }
              }}
              title="Show every bucket the API returned (for debugging mismatches). Click again to refresh."
              style={{
                background: 'transparent',
                color: 'inherit',
                border: '1px solid var(--color-border)',
                fontFamily: 'var(--font-pixel)',
                fontSize: '0.5625rem',
                padding: '1px 6px',
                cursor: 'pointer',
                opacity: 0.6,
              }}
            >
              {debugAllBuckets ? '✗ debug' : 'debug buckets'}
            </button>
          </div>
          {debugAllBuckets && (
            <div
              style={{
                marginTop: 4,
                padding: 6,
                background: 'var(--color-bg-dark)',
                border: '1px solid var(--color-border)',
                fontFamily: 'Menlo, Consolas, monospace',
                fontSize: '0.625rem',
                lineHeight: 1.4,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 280,
                overflow: 'auto',
              }}
              title="Raw bucket data from the OAuth /usage endpoint. Copy/paste this back if a value looks wrong."
            >
              {(() => {
                const lines: string[] = [];
                const fmt = (b?: { utilization: number; resets_at: string }): string =>
                  b ? `${(b.utilization * 100).toFixed(1)}% (resets ${b.resets_at || '?'})` : '—';
                lines.push('# canonical (what the FE uses for the bars)');
                if (oauthLimits) {
                  lines.push(`five_hour:        ${fmt(oauthLimits.five_hour)}`);
                  lines.push(`seven_day:        ${fmt(oauthLimits.seven_day)}`);
                  lines.push(`seven_day_sonnet: ${fmt(oauthLimits.seven_day_sonnet)}`);
                  if (oauthLimits.error) lines.push(`error: ${oauthLimits.error}`);
                } else {
                  lines.push('(no oauthLimits — call hasn\'t resolved yet)');
                }
                lines.push('');
                const src = oauthLimits?.all_buckets ?? cachedLimits?.allBuckets ?? {};
                const sourceTag = oauthLimits?.all_buckets
                  ? '(live)'
                  : cachedLimits?.allBuckets
                    ? '(cached)'
                    : '(none)';
                const entries = Object.entries(src).sort((a, b) =>
                  a[0].localeCompare(b[0]),
                );
                lines.push(`# all_buckets ${sourceTag} — ${entries.length} keys`);
                if (entries.length === 0) {
                  lines.push('(empty — Rust harvest returned nothing,');
                  lines.push(' or the cached entry was written before this');
                  lines.push(' field existed. Wait ~10s for refreshOauth.)');
                } else {
                  for (const [k, v] of entries) {
                    lines.push(`${k}: ${(v.utilization * 100).toFixed(1)}%`);
                  }
                }
                return lines.join('\n');
              })()}
            </div>
          )}
          {limitsSource === 'cached' && cachedLimits && (
            <div
              style={{
                fontSize: '0.5625rem',
                opacity: 0.55,
                lineHeight: 1.4,
                color: 'var(--color-warning, #f59e0b)',
              }}
              title="Live limits endpoint is unavailable — these are the last values we observed"
            >
              last reading · {formatTimeAgo(cachedLimits.ts, now)} ({cachedLimits.source})
            </div>
          )}
          {limitsSource === 'none' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: '0.625rem', opacity: 0.7, lineHeight: 1.4 }}>
                {oauthLimits?.error
                  ? `live limits unavailable: ${oauthLimits.error}`
                  : 'fetching live limits…'}
              </div>
              <button
                type="button"
                onClick={() => void refreshOauth()}
                title="Retry the claude.ai/api/oauth/usage call now"
                style={{
                  alignSelf: 'flex-start',
                  padding: '2px 8px',
                  background: 'transparent',
                  color: 'inherit',
                  border: '1px solid var(--color-border)',
                  fontFamily: 'var(--font-pixel)',
                  fontSize: '0.625rem',
                  cursor: 'pointer',
                }}
              >
                ↻ Retry
              </button>
            </div>
          )}

          {/* Bonus stats from the snapshot — context window + total cost. */}
          {snapshotFresh && snapshot && (
            <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {snapshot.context_window && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6875rem', opacity: 0.85 }}>
                  <span style={{ opacity: 0.7 }}>Context</span>
                  <span style={{ color: pctColor(ctxPct) }}>{ctxPct}% used</span>
                </div>
              )}
              {totalCostUsd > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6875rem', opacity: 0.85 }}>
                  <span style={{ opacity: 0.7 }}>Spent</span>
                  <span>{formatUsd(totalCostUsd)}</span>
                </div>
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
              fontSize: '0.6875rem',
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
  bucket: RateLimitBucket;
  now: number;
}

function UsageBar({ label, bucket, now }: UsageBarProps): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, bucket.used_percentage ?? 0));
  const color = pctColor(pct);
  const countdown = bucket.resets_at ? formatResetCountdown(bucket.resets_at, now) : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '0.6875rem',
        }}
      >
        <span style={{ opacity: 0.7 }}>{label}</span>
        <span style={{ color, fontWeight: 'bold' }}>{Math.round(pct)}%</span>
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
            width: `${pct}%`,
            height: '100%',
            background: color,
            transition: 'width 300ms ease-out',
          }}
        />
      </div>
      {countdown && (
        <div style={{ fontSize: '0.625rem', opacity: 0.5 }}>resets {countdown}</div>
      )}
    </div>
  );
}
