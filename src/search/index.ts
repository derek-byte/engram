import type { SearchFilters, SearchResult } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';

export async function runSearch(
  query: string,
  filters: SearchFilters,
  deps: { backend: VectorBackend; embedder: Embedder }
): Promise<SearchResult[]> {
  const vec = await deps.embedder.embedOne(query);
  return deps.backend.search(vec, query, filters);
}
