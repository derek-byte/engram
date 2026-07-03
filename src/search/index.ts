import type { SearchFilters, SearchResult } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';
import type { OpenAIReranker } from './rerank.ts';

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
