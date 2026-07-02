import type { Chunk, RawEvent, SearchFilters, SearchResult } from '../types/index.ts';

export interface EmbeddingCache {
  getCachedEmbeddings(shas: string[], model: string): Promise<Map<string, number[]>>;
  putCachedEmbeddings(entries: Array<{ sha: string; embedding: number[] }>, model: string): Promise<void>;
}

export interface VectorBackend extends EmbeddingCache {
  initialize(): Promise<void>;
  insertRawEvents(events: RawEvent[]): Promise<number>;
  upsert(chunks: Chunk[]): Promise<void>;
  search(queryEmbedding: number[], queryText: string, filters: SearchFilters): Promise<SearchResult[]>;
  count(): Promise<number>;
  close(): Promise<void>;
}
