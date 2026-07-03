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
  getTrajectory(trajectoryId: string): Promise<Chunk[]>;
  count(): Promise<number>;
  close(): Promise<void>;
}

// A synthesis unit: all raw chunks of one (sessionId, repo), aggregated for the
// dream layer. chunkIds are sorted (by id) so the fingerprint is order-stable.
export interface SynthesisUnit {
  sessionId: string;
  repo: string;
  chunkIds: string[];
  totalChars: number;
  lastTimestamp: Date;
}

// Persisted per-unit dream state, keyed (owner, sessionId, repo). The fingerprint
// short-circuit lives here so an empty extraction (unit synthesized, zero chunks)
// still records state independent of any chunk row.
export interface DreamUnitRow {
  owner: string;
  sessionId: string;
  repo: string;
  fingerprint: string;
  sourceChunkIds: string[];
  dreamChunkIds: string[];
  model: string;
}

// The dream layer's storage seam, kept separate from VectorBackend so the
// vector-store contract stays minimal. PgVectorBackend implements both.
export interface DreamStore {
  listSynthesisUnits(opts: { owner: string; repo?: string; since?: Date }): Promise<SynthesisUnit[]>;
  getUnitChunks(owner: string, sessionId: string, repo: string): Promise<Chunk[]>;
  getDreamUnits(owner: string): Promise<DreamUnitRow[]>;
  upsertDreamUnit(row: DreamUnitRow): Promise<void>;
  deleteDreamChunks(ids: string[], owner: string): Promise<number>;
}
