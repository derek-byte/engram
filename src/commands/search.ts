import { loadConfig, promptForMissing, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { Embedder } from '../ingest/embed.ts';
import { runSearch } from '../search/index.ts';
import type { SearchFilters, SearchResult } from '../types/index.ts';

export interface SearchOptions {
  branch?: string;
  repo?: string;
  since?: string;
  limit?: string;
  json?: boolean;
}

export async function searchCommand(query: string, opts: SearchOptions): Promise<void> {
  let config = loadConfig();
  if (!configIsComplete(config)) {
    console.log("engram isn't configured yet. Run 'engram backfill' first.");
    process.exit(1);
  }

  const filters: SearchFilters = {
    branch: opts.branch,
    repo: opts.repo,
    since: opts.since ? new Date(opts.since) : undefined,
    limit: opts.limit ? Number(opts.limit) : 5,
  };

  const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim);
  await backend.initialize();
  const embedder = new Embedder(config.openaiApiKey, config.embeddingModel);

  try {
    const results = await runSearch(query, filters, { backend, embedder });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printResults(results);
    }
  } finally {
    await backend.close();
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
    const sim = r.similarity.toFixed(3);
    console.log(`◆ ${m.repo}@${m.branch || '(no-branch)'} · ${when} · sim=${sim}`);
    console.log(`  ${preview(r.chunk.content, 200)}`);
    if (m.filePaths.length > 0) {
      console.log(`  files: ${m.filePaths.slice(0, 3).join(', ')}${m.filePaths.length > 3 ? '…' : ''}`);
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
