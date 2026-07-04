import { LocalStore } from '../storage/local.ts';

export interface DemandOptions {
  days?: string;
  json?: boolean;
}

// Clamp the lookback window to a sane range; default 30 days (matches the
// LocalStore defaults and the UI's demand section).
function clampDays(value: string | undefined): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(n, 1), 365);
}

// sqlite stores demand ts as UTC 'YYYY-MM-DD HH:MM:SS'; render it as a coarse
// relative age (same vocabulary as search's recents).
function ago(ts: string): string {
  const then = new Date(ts.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(then)) return ts;
  const diff = Math.max(0, Date.now() - then);
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

// `engram demand [--days 30] [--json]` — the unmet-demand report: questions the
// memory could not answer, grouped and counted, the shopping list for future
// capture / targeted synthesis. `injected` is a test seam (temp LocalStore).
export async function demandCommand(opts: DemandOptions, injected?: LocalStore): Promise<void> {
  const days = clampDays(opts.days);
  const local = injected ?? new LocalStore();

  try {
    const summary = local.demandSummary(days);
    const unmet = local.unmetDemand(days);

    if (opts.json) {
      console.log(JSON.stringify({ summary, unmet }, null, 2));
      return;
    }

    console.log(`engram demand · last ${days} days`);
    console.log('─────────────────────────────');
    console.log(
      `${summary.total} events · ${summary.searches} searches · ${summary.asks} asks · ` +
        `${summary.unmet} unmet (${summary.unmetQueries} ${summary.unmetQueries === 1 ? 'query' : 'queries'})`
    );

    if (unmet.length === 0) {
      console.log('');
      console.log('No unmet demand — memory covered everything asked of it.');
      return;
    }

    console.log('');
    console.log(formatRow('count', 'last', 'coverage', 'query'));
    for (const r of unmet) {
      console.log(
        formatRow(
          String(r.count),
          ago(r.latestTs),
          // Best hit's tier: 'raw' + sessionId ⇒ uncompiled material the nightly
          // targeted pass will pick up; other tiers ⇒ compiled but weak (quality
          // gap, not a synthesis gap); '—' ⇒ nothing captured yet (needs capture).
          r.topTier === 'raw' && r.topSessionId ? 'raw' : (r.topTier ?? '—'),
          r.query
        )
      );
    }
  } finally {
    if (!injected) local.close();
  }
}

function formatRow(count: string, last: string, coverage: string, query: string): string {
  return `${count.padStart(5)}  ${last.padEnd(9)}  ${coverage.padEnd(8)}  ${query}`;
}
