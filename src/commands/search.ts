import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { runSearch, demandRowForSearch, demandRowForSearchError } from '../search/index.ts';
import { buildReranker } from '../search/rerank.ts';
import type { SearchFilters, SearchResult } from '../types/index.ts';

export interface SearchOptions {
  branch?: string;
  repo?: string;
  since?: string;
  tier?: string;
  limit?: string;
  rerank?: boolean;
  includeSuperseded?: boolean;
  json?: boolean;
}

export function parseTier(value: string | undefined): SearchFilters['tier'] {
  if (value === undefined) return 'all';
  if (value === 'raw' || value === 'dream' || value === 'wiki' || value === 'synth' || value === 'all' || value === 'both') {
    return value;
  }
  throw new Error(`invalid --tier: ${value} (expected 'raw', 'dream', 'wiki', 'synth', or 'all')`);
}

export async function searchCommand(query: string, opts: SearchOptions): Promise<void> {
  const config = loadConfig();
  if (!configIsComplete(config)) {
    console.error("engram isn't configured yet. Run 'engram backfill' first.");
    process.exit(1);
  }

  const filters: SearchFilters = {
    branch: opts.branch,
    repo: opts.repo,
    since: opts.since ? new Date(opts.since) : undefined,
    tier: parseTier(opts.tier),
    limit: opts.limit ? Number(opts.limit) : 5,
    includeSuperseded: opts.includeSuperseded,
  };

  const backend = PgVectorBackend.fromConfig(config);
  await backend.initialize();
  const embedder = new Embedder(buildProvider(config));
  const local = new LocalStore();

  const rerankOn = opts.rerank ?? config.rerank.enabled;
  const reranker = rerankOn ? buildReranker(config) : undefined;

  const tier = filters.tier ?? null;
  try {
    const results = await runSearch(query, filters, { backend, embedder, reranker });
    // Demand signal (roadmap #6): CLI was a blind surface — every settled query
    // logs, incl. zero-hit (the strongest unmet-demand signal). Swallow-all;
    // telemetry must never break search.
    try {
      if (results.length > 0) local.logRecent('search', query, query);
      local.logDemand(demandRowForSearch('cli', query, tier, opts.repo ?? null, results));
    } catch {
      /* demand log is telemetry */
    }
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printResults(results);
    }
  } catch (err) {
    try {
      local.logDemand(demandRowForSearchError('cli', query, tier, opts.repo ?? null));
    } catch {
      /* demand log is telemetry */
    }
    throw err;
  } finally {
    await backend.close();
    local.close();
  }
}

function printResults(results: SearchResult[]): void {
  if (results.length === 0) {
    console.log('No results.');
    return;
  }
  for (const r of results) {
    const m = r.chunk.metadata;
    const when = relativeTime(m.timestamp);
    const scores = `combined=${r.combined.toFixed(3)} sim=${r.similarity.toFixed(3)} kw=${r.keywordRank.toFixed(3)}`;
    const rank = r.rerankRank !== undefined ? ` rank=#${r.rerankRank}` : '';
    if (m.tier === 'wiki') {
      const slug = m.trajectoryId?.replace(/^wiki:/, '') ?? '?';
      const prov = m.sourceChunkIds?.length ?? 0;
      console.log(`◆ [wiki:${m.dreamType ?? '?'}] ${slug} · ${when} · ${scores}${rank}`);
      console.log(`  ${preview(r.chunk.content, 200)}`);
      console.log(`  page: ${slug} · provenance: ${prov} dream chunk${prov === 1 ? '' : 's'}`);
    } else {
      const tag = m.tier === 'dream' ? ` [dream:${m.dreamType ?? '?'}]` : '';
      console.log(`◆ ${m.repo}@${m.branch || '(no-branch)'}${tag} · ${when} · ${scores}${rank}`);
      console.log(`  ${preview(r.chunk.content, 200)}`);
      if (m.filePaths.length > 0) {
        console.log(`  files: ${m.filePaths.slice(0, 3).join(', ')}${m.filePaths.length > 3 ? '…' : ''}`);
      }
    }
    console.log('');
  }
}

function preview(s: string, max: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max) + '…';
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}
