// Plan usage (5-hour session window + weekly limit) for the header gauge.
//
// Source order, cheapest first:
//   1. statusline snapshot written by running sessions (local file, free);
//   2. the shared "last known limits" cache (also fed by the Usage tab);
//   3. the claude.ai OAuth usage endpoint — at most once per
//      PLAN_USAGE_OAUTH_MIN_INTERVAL_MS across the whole app, because it
//      answers HTTP 429 when polled too often.

import { useEffect, useState } from 'react';

import { PLAN_USAGE_OAUTH_MIN_INTERVAL_MS, PLAN_USAGE_POLL_MS } from '../constants';
import { readClaudeUsageLimits, readClaudeUsageSnapshot } from '../tauri/commands';
import {
  oauthLimitsToBuckets,
  parseSnapshot,
  type RateLimitBucket,
  readCachedLimits,
  SNAPSHOT_STALE_MS,
  writeCachedLimits,
} from '../usageLimits';

export interface PlanUsage {
  fiveHour?: RateLimitBucket;
  sevenDay?: RateLimitBucket;
  /** Where the numbers come from; 'cache' = last known reading. */
  source: 'snapshot' | 'oauth' | 'cache' | 'none';
  /** When the numbers were observed (epoch ms, 0 if none). */
  observedAt: number;
  /** When this reading was resolved — the render-time "now" for countdowns. */
  checkedAt: number;
}

const NONE: PlanUsage = { source: 'none', observedAt: 0, checkedAt: 0 };

async function resolvePlanUsage(): Promise<PlanUsage> {
  const now = Date.now();
  // 1. Live snapshot from a running session.
  try {
    const snap = await readClaudeUsageSnapshot();
    const parsed = parseSnapshot(snap.body);
    const limits = parsed?.rate_limits;
    if (limits && snap.mtime_ms > 0 && now - snap.mtime_ms < SNAPSHOT_STALE_MS) {
      writeCachedLimits({ ts: now, source: 'snapshot', limits });
      return { fiveHour: limits.five_hour, sevenDay: limits.seven_day, source: 'snapshot', observedAt: now, checkedAt: now };
    }
  } catch (e) {
    console.debug('[Elyone][usePlanUsage] snapshot read failed', e);
  }
  // 2. Recent cached reading: don't hit the OAuth endpoint again.
  const cached = readCachedLimits();
  if (cached && now - cached.ts < PLAN_USAGE_OAUTH_MIN_INTERVAL_MS) {
    return { fiveHour: cached.limits.five_hour, sevenDay: cached.limits.seven_day, source: 'cache', observedAt: cached.ts, checkedAt: now };
  }
  // 3. OAuth endpoint.
  try {
    const oauth = await readClaudeUsageLimits();
    const buckets = oauthLimitsToBuckets(oauth);
    if (buckets) {
      writeCachedLimits({ ts: now, source: 'oauth', limits: buckets, allBuckets: oauth.all_buckets });
      return { fiveHour: buckets.five_hour, sevenDay: buckets.seven_day, source: 'oauth', observedAt: now, checkedAt: now };
    }
  } catch (e) {
    console.debug('[Elyone][usePlanUsage] OAuth limits failed', e);
  }
  // Fall back to whatever was last seen, however old.
  if (cached) {
    return { fiveHour: cached.limits.five_hour, sevenDay: cached.limits.seven_day, source: 'cache', observedAt: cached.ts, checkedAt: now };
  }
  return { ...NONE, checkedAt: now };
}

export function usePlanUsage(): PlanUsage {
  const [usage, setUsage] = useState<PlanUsage>(NONE);
  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      void resolvePlanUsage().then((u) => {
        if (!cancelled) setUsage(u);
      });
    };
    tick();
    const id = setInterval(tick, PLAN_USAGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return usage;
}
