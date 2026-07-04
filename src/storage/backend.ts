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
  listSynthesisUnits(opts: { owner: string; repo?: string; since?: Date; sessionId?: string }): Promise<SynthesisUnit[]>;
  // tier defaults to 'raw' (the dream layer's source); the wiki layer passes 'dream'.
  getUnitChunks(owner: string, sessionId: string, repo: string, tier?: 'raw' | 'dream'): Promise<Chunk[]>;
  getDreamUnits(owner: string): Promise<DreamUnitRow[]>;
  upsertDreamUnit(row: DreamUnitRow): Promise<void>;
  deleteDreamChunks(ids: string[], owner: string): Promise<number>;
}

// Persisted per-unit wiki ingest state, keyed (owner, sessionId, repo). Mirror of
// DreamUnitRow: the fingerprint (sha256 of the unit's sorted dream-chunk ids)
// changes exactly when the dream layer re-synthesizes the unit, so a matching
// fingerprint short-circuits the ingest — re-runs are 100% skip, zero LLM calls.
export interface WikiUnitRow {
  owner: string;
  sessionId: string;
  repo: string;
  fingerprint: string;
  sourceChunkIds: string[];
  pages: string[];
  model: string;
}

// The context layer's storage seam (feeds `engram context`). All three methods
// are read-only, owner-scoped, and LLM/embedding-free — the command must run in
// <2s at session start. PgVectorBackend implements this alongside the others.
export interface ContextStore {
  // Wiki pages whose source_chunk_ids trace to dream chunks of this repo,
  // ranked by matched-source count desc, then chunk timestamp desc, then slug asc.
  wikiPagesForRepo(
    owner: string,
    repo: string,
    limit: number
  ): Promise<Array<{ slug: string; matchCount: number; lastChunkAt: Date | null; excerpt: string }>>;
  // Recent dream chunks (decisions/gotchas) for a repo, newest first.
  recentDreamChunks(owner: string, repo: string, since: Date, types: string[], limit: number): Promise<Chunk[]>;
  // websearch_to_tsquery keyword search within one tier, ranked by ts_rank_cd desc.
  keywordSearchChunks(
    owner: string,
    tier: string,
    queryText: string,
    limit: number
  ): Promise<Array<{ trajectoryId: string | null; rank: number; content: string }>>;
}

// The wiki layer's storage seam. PgVectorBackend implements this alongside
// DreamStore + VectorBackend.
export interface WikiLedger {
  getWikiUnits(owner: string): Promise<WikiUnitRow[]>;
  upsertWikiUnit(row: WikiUnitRow): Promise<void>;
  // Groups tier='dream' chunks by (session_id, repo) — the wiki layer's source
  // units, same shape as listSynthesisUnits (which groups tier='raw').
  listDreamUnitsAsUnits(owner: string, opts?: { repo?: string; since?: Date }): Promise<SynthesisUnit[]>;
  // Tier-scoped delete used by wiki reindex to retract stale rows defensively.
  deleteChunksByIds(ids: string[], owner: string, tier: string): Promise<number>;
  // (id, trajectory_id) for every tier='wiki' chunk of an owner — reindex reconciliation.
  listWikiChunkIds(owner: string): Promise<Array<{ id: string; trajectoryId: string | null }>>;
}
