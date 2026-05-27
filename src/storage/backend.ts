import type { Chunk, SearchFilters, SearchResult } from '../types/index.ts';

export interface VectorBackend {
  initialize(): Promise<void>;
  upsert(chunks: Chunk[]): Promise<void>;
  search(queryEmbedding: number[], filters: SearchFilters): Promise<SearchResult[]>;
  count(): Promise<number>;
  close(): Promise<void>;
}
