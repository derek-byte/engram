import type { SearchFilters, SearchResult } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';
import type { OpenAIReranker } from './rerank.ts';
import type { DemandRow } from '../storage/local.ts';

export async function runSearch(
  query: string,
  filters: SearchFilters,
  deps: { backend: VectorBackend; embedder: Embedder; reranker?: OpenAIReranker }
): Promise<SearchResult[]> {
  const vec = await deps.embedder.embedOne(query);
  if (!deps.reranker) return deps.backend.search(vec, query, filters);

  const limit = filters.limit ?? 5;
  const pool = await deps.backend.search(vec, query, {
    ...filters,
    limit: Math.max(deps.reranker.topK, limit),
  });
  const reranked = await deps.reranker.rerank(query, pool);
  return (reranked ?? pool).slice(0, limit);
}

// The canonical demand row for a settled search, shared by every surface
// (CLI, MCP, UI) so the shape stays identical — the ask surfaces got this via
// demandRowForAsk while search rows were hand-built per surface and drifted.
// top_* come from the best hit; a zero-hit row leaves them null.
export function demandRowForSearch(
  surface: DemandRow['surface'],
  query: string,
  tier: string | null,
  repo: string | null,
  results: SearchResult[]
): DemandRow {
  const top = results[0];
  return {
    surface,
    kind: 'search',
    query,
    tier,
    repo,
    resultCount: results.length,
    topSimilarity: top?.similarity ?? null,
    topTier: top?.chunk.metadata.tier ?? null,
    topSessionId: top?.chunk.metadata.sessionId ?? null,
  };
}

// The error-path variant: a FAILED search must not read as a genuine zero-hit
// in the unmet-demand report, so it carries outcome: 'error' (the UI's old
// inline catch row omitted this — failed and zero-hit were indistinguishable).
export function demandRowForSearchError(
  surface: DemandRow['surface'],
  query: string,
  tier: string | null,
  repo: string | null
): DemandRow {
  return { surface, kind: 'search', query, tier, repo, resultCount: 0, outcome: 'error' };
}
