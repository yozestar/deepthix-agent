// Header gauge: plan consumption for the 5-hour session window and the
// weekly limit. Blue under 60 %, amber from 60 %, red from 85 % (same
// thresholds as the Usage tab). Click opens the Usage tab. When no
// reading is available it says so instead of disappearing.

import { Gauge } from 'lucide-react';

import { formatWhen } from '../conversationUtils';
import { usePlanUsage } from '../hooks/usePlanUsage';
import type { RateLimitBucket } from '../usageLimits';

/** "dans 2 h 10" / "dans 3 j 4 h" from an epoch-seconds reset time. */
function resetsIn(epochSec: number | undefined, now: number): string {
  if (!epochSec) return '';
  const ms = epochSec * 1000 - now;
  if (ms <= 0) return 'maintenant';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `dans ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `dans ${h} h ${String(min % 60).padStart(2, '0')}`;
  return `dans ${Math.floor(h / 24)} j ${h % 24} h`;
}

function level(pct: number): 'ok' | 'warn' | 'high' {
  if (pct >= 85) return 'high';
  if (pct >= 60) return 'warn';
  return 'ok';
}

function Meter({ label, bucket, now }: { label: string; bucket?: RateLimitBucket; now: number }): React.JSX.Element | null {
  if (!bucket || typeof bucket.used_percentage !== 'number') return null;
  const pct = Math.max(0, Math.min(100, Math.round(bucket.used_percentage)));
  const reset = resetsIn(bucket.resets_at, now);
  return (
    <span className={`dt-usage-meter is-${level(pct)}`} title={`${label} : ${pct} %${reset ? ` — réinitialisation ${reset}` : ''}`}>
      <span className="dt-usage-label">{label}</span>
      <span className="dt-usage-bar" aria-hidden>
        <span style={{ width: `${Math.max(pct, 2)}%` }} />
      </span>
      <span className="dt-usage-pct">{pct} %</span>
    </span>
  );
}

export function PlanUsageGauge({ onOpenUsage }: { onOpenUsage: () => void }): React.JSX.Element | null {
  const usage = usePlanUsage();
  if (usage.source === 'none' || (!usage.fiveHour && !usage.sevenDay)) {
    // Stay visible so the user knows where the gauge lives.
    return (
      <button
        type="button"
        className="dt-usage is-stale"
        onClick={onOpenUsage}
        title="Aucune mesure de consommation reçue pour l'instant (cliquer pour le détail)"
      >
        <Gauge size="1.05em" strokeWidth={1.75} aria-hidden />
        <span className="dt-usage-label">Consommation indisponible</span>
      </button>
    );
  }
  const now = usage.checkedAt;
  const stale = usage.source === 'cache' && now - usage.observedAt > 15 * 60_000;
  return (
    <button
      type="button"
      className={`dt-usage${stale ? ' is-stale' : ''}`}
      onClick={onOpenUsage}
      title={
        stale
          ? `Consommation Claude — dernière mesure ${formatWhen(usage.observedAt)} (cliquer pour le détail)`
          : 'Consommation Claude (cliquer pour le détail)'
      }
    >
      <Gauge size="1.05em" strokeWidth={1.75} aria-hidden />
      <Meter label="Session 5 h" bucket={usage.fiveHour} now={now} />
      <Meter label="Semaine" bucket={usage.sevenDay} now={now} />
      {stale && <span className="dt-usage-stale">{formatWhen(usage.observedAt)}</span>}
    </button>
  );
}
