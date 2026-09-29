// Plan-usage limits shared by the Usage tab and the header gauge:
// statusline-snapshot parsing, OAuth bucket normalisation and the
// "last known limits" cache (localStorage) that both read and write, so
// the rate-limited OAuth endpoint is never polled twice for nothing.

import type { ClaudeUsageLimits } from './tauri/commands';

/** A statusline snapshot younger than this is considered live. */
export const SNAPSHOT_STALE_MS = 5 * 60 * 1000;

export interface RateLimitBucket {
  used_percentage?: number;
  resets_at?: number; // epoch seconds
}

export interface ParsedSnapshot {
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

export function oauthLimitsToBuckets(
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

// Persist the most recently observed limits + timestamp so the pane
// can fall back to "last known" instead of going blank when both the
// snapshot is stale AND the OAuth endpoint is rate-limited / down.
// User explicitly asked for this — they'd rather see a 4h-old reading
// than "limits unavailable" with nothing useful to act on.
export const LAST_LIMITS_STORAGE_KEY = 'deepthix.usage.lastLimits';

export interface CachedLimits {
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

export function readCachedLimits(): CachedLimits | null {
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

export function writeCachedLimits(c: CachedLimits): void {
  try {
    localStorage.setItem(LAST_LIMITS_STORAGE_KEY, JSON.stringify(c));
    console.debug('[Deepthix][UsagePane] cached limits written', { source: c.source, ts: c.ts });
  } catch (e) {
    console.warn('[Deepthix][UsagePane] cached limits write failed', e);
  }
}

export function parseSnapshot(body: string): ParsedSnapshot | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as ParsedSnapshot;
  } catch (e) {
    console.warn('[Deepthix][UsagePane] snapshot parse failed', e);
    return null;
  }
}

