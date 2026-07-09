import type { Artifact, Chunk, RawEvent, SearchFilters, SearchResult, Trajectory } from '../types/index.ts';

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

// A (session, repo) whose dream layer holds knowledge no wiki compile has
// absorbed yet, and which the nightly loop has left un-healed for `ageHours`.
// Surfaced by wiki lint's `pending-unit` rule. ageHours is the age of the
// dream_units.synthesized_at stamp at check time.
export interface PendingUnit {
  sessionId: string;
  repo: string;
  ageHours: number;
}

// Evidence roll-up over a wiki page's dream sources: distinct sessions and the
// timestamp span. Feeds the page-overlay evidence header ("N sessions · … →").
export interface WikiPageEvidence {
  sessionCount: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
}

// Read-only trust/evidence queries over the pg store, used by wiki lint (the
// backend-dependent rules) and the UI page overlay. Kept separate from the
// vector/dream/wiki seams so those contracts stay minimal. PgVectorBackend
// implements this alongside the others.
export interface WikiEvidenceStore {
  // Subset of the given ids that exist as chunks of the given tier — the
  // broken-provenance check (sources must be real dream chunks).
  existingChunkIds(ids: string[], tier: string): Promise<Set<string>>;
  // (session, repo) units whose current dream knowledge differs from what the
  // wiki ledger absorbed AND whose dream stamp is older than staleHours.
  pendingWikiUnits(owner: string, staleHours?: number): Promise<PendingUnit[]>;
  // Distinct sessions + first/last timestamp over the given source chunk ids.
  wikiPageEvidence(sourceIds: string[]): Promise<WikiPageEvidence>;
}

// Maintenance/backfill seam: artifact re-derivation and owner-scoped retraction.
// Kept off VectorBackend so the hot-path contract stays minimal. Only the
// backfill sweep, the artifacts re-derive, and the retraction/bench-teardown
// callers depend on this. PgVectorBackend implements it alongside the others.
export interface MaintenanceStore {
  // Raw trajectories for artifact backfill: content_sha256 == trajectoryId, payload = full Trajectory.
  rawTrajectoriesForArtifacts(source: string): Promise<Array<{ trajectoryId: string; payload: Trajectory }>>;
  // Attach artifacts to a trajectory's raw chunks. Never touches embeddings/content.
  setChunkArtifacts(trajectoryId: string, artifacts: Artifact[]): Promise<number>;
  // Sweep an owner's chunks of one tier whose chunker_version differs from
  // `currentVersion` (NULL counts as differing) — the stale rows a reindex
  // leaves behind after the re-ingest pass has fully succeeded. Owner+tier+
  // version-scoped so no other owner's or tier's rows can ever be touched.
  deleteChunksByStaleVersion(owner: string, tier: string, currentVersion: string): Promise<number>;
  // Retract every chunk + raw event + dream/wiki unit for an owner, atomically.
  deleteByOwner(owner: string): Promise<{ chunks: number; rawEvents: number }>;
  // Same, for every owner sharing a prefix (e.g. 'bench:' → 'bench:%').
  deleteByOwnerPrefix(prefix: string): Promise<{ chunks: number; rawEvents: number }>;
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
