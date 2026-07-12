import postgres from 'postgres';
import type { Artifact, Chunk, EngramConfig, RawEvent, ScoringConfig, SearchFilters, SearchResult, Trajectory } from '../types/index.ts';
import type { ContextStore, DreamStore, DreamUnitRow, DreamUnitWikiRow, MaintenanceStore, SynthesisUnit, VectorBackend, WikiEvidenceStore, WikiLedger, WikiPageEvidence, WikiUnitRow } from './backend.ts';
import { CHUNKER_VERSION } from '../types/index.ts';

// Schema version gate for the initialize() fast path. BUMP THIS ON ANY DDL EDIT
// in initialize() (new table/column/index, changed type, etc.) — otherwise a
// deployed backend with a matching stored version will SKIP the full DDL and
// never apply your change. Bumping forces the full DDL + version re-stamp once.
const SCHEMA_VERSION = 2;

// Rows/statement for batched multi-row INSERTs (upsert, raw events, cache).
const INSERT_BATCH = 100;

// Map a SearchFilters tier to the concrete tier list, or null for "no tier
// filter" ('all'/'both'/undefined). 'synth' = wiki+dream.
function tiersFor(tier: SearchFilters['tier']): string[] | null {
  switch (tier) {
    case 'raw':
    case 'dream':
    case 'wiki':
      return [tier];
    case 'synth':
      return ['wiki', 'dream'];
    default:
      return null;
  }
}

const DEFAULT_OWNER = 'derek';

const DEFAULT_SCORING: ScoringConfig = {
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  timeDecayHalfLifeDays: 0,
  recencyWeight: 0.1,
  recencyHalfLifeDays: 30,
  importanceWeight: 0.1,
};

// Generative-Agents-style importance prior: synthesized knowledge (wiki, then
// dream) outranks raw transcript at equal similarity. Bounded [0,1], scaled by
// importanceWeight in the combined score.
const TIER_PRIORS = { wiki: 1.0, dream: 0.85, raw: 0.6 } as const;

// Two-arm candidate pool re-ranked by hybrid score: vector top-100 (HNSW) UNION
// keyword top-50 (GIN ts_rank_cd), so an exact-identifier match outside the
// vector neighbourhood still surfaces. See search/README.md.
const CANDIDATE_POOL = 100;
const KEYWORD_POOL = 50;

// Canonical shape rowToChunk consumes. Every field is nullable/optional so a
// query may SELECT only the columns it needs (missing keys read as undefined).
type ChunkRow = {
  id: string;
  content: string;
  repo?: string | null;
  branch?: string | null;
  timestamp?: Date | null;
  file_paths?: string[] | null;
  exit_code?: number | null;
  session_id?: string | null;
  cwd?: string | null;
  tier: 'raw' | 'dream' | 'wiki';
  owner?: string | null;
  dream_type?: string | null;
  source_chunk_ids?: string[] | null;
  trajectory_id?: string | null;
  chunk_index?: number | null;
  chunk_count?: number | null;
  artifacts?: Artifact[] | null;
  invalid_at?: Date | null;
  superseded_by?: string | null;
};

export class PgVectorBackend implements VectorBackend, DreamStore, WikiLedger, WikiEvidenceStore, ContextStore, MaintenanceStore {
  private sql: ReturnType<typeof postgres>;
  private embeddingDim: number;
  private embeddingModel: string;
  private chunkerVersion: string;
  private scoring: ScoringConfig;

  constructor(
    databaseUrl: string,
    embeddingDim: number,
    embeddingModel: string,
    chunkerVersion: string,
    scoring: ScoringConfig = DEFAULT_SCORING,
    opts?: { connectTimeoutSec?: number }
  ) {
    // SSL is derived from the URL (e.g. ?sslmode=require for Neon).
    // Local Postgres URLs without sslmode connect without TLS.
    // connect_timeout defaults to 10s (down from postgres.js's 30s) so a dead
    // host fails fast instead of hanging the CLI/hooks.
    this.sql = postgres(databaseUrl, {
      prepare: false,
      onnotice: () => {},
      connect_timeout: opts?.connectTimeoutSec ?? 10,
    });
    this.embeddingDim = embeddingDim;
    this.embeddingModel = embeddingModel;
    this.chunkerVersion = chunkerVersion;
    this.scoring = scoring;
  }

  // Build a backend from an EngramConfig: stamps CHUNKER_VERSION and lifts the
  // scoring weights out of config so call sites don't re-thread them. opts flows
  // connect_timeout through to the constructor.
  static fromConfig(config: EngramConfig, opts?: { connectTimeoutSec?: number }): PgVectorBackend {
    return new PgVectorBackend(
      config.databaseUrl,
      config.embeddingDim,
      config.embeddingModel,
      CHUNKER_VERSION,
      {
        vectorWeight: config.vectorWeight,
        keywordWeight: config.keywordWeight,
        timeDecayHalfLifeDays: config.timeDecayHalfLifeDays,
        recencyWeight: config.recencyWeight,
        recencyHalfLifeDays: config.recencyHalfLifeDays,
        importanceWeight: config.importanceWeight,
      },
      opts
    );
  }

  async initialize(): Promise<void> {
    // Fast path: if schema_meta records our version, the full DDL already ran
    // for this SCHEMA_VERSION — skip every CREATE. A missing schema_meta table
    // (42P01, fresh DB or pre-versioning schema) or a version mismatch falls
    // through to the full DDL, which is idempotent (IF NOT EXISTS throughout).
    try {
      const [row] = await this.sql<Array<{ value: string }>>`
        SELECT value FROM schema_meta WHERE key = 'schema_version'
      `;
      if (row && Number(row.value) === SCHEMA_VERSION) {
        await this.assertEmbeddingDim();
        return;
      }
    } catch (e) {
      if ((e as { code?: string }).code !== '42P01') throw e; // 42P01 = undefined_table
    }

    await this.sql`CREATE EXTENSION IF NOT EXISTS vector`;

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS raw_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner TEXT NOT NULL DEFAULT '${DEFAULT_OWNER}',
        source TEXT NOT NULL,
        session_id TEXT,
        content_sha256 TEXT NOT NULL,
        occurred_at TIMESTAMPTZ,
        ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload JSONB NOT NULL
      );
    `);
    await this.sql.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS raw_events_sha_idx ON raw_events (content_sha256);`
    );
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS raw_events_owner_idx ON raw_events (owner);`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS raw_events_session_idx ON raw_events (session_id);`);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        embedding vector(${this.embeddingDim}),
        content TEXT NOT NULL,
        model_id TEXT NOT NULL,
        embedding_dim INTEGER NOT NULL,
        owner TEXT NOT NULL DEFAULT '${DEFAULT_OWNER}',
        chunker_version TEXT,
        embedding_model TEXT,
        repo TEXT,
        branch TEXT,
        timestamp TIMESTAMPTZ,
        file_paths TEXT[],
        exit_code INTEGER,
        session_id TEXT,
        cwd TEXT,
        tier TEXT DEFAULT 'raw',
        dream_type TEXT,
        source_chunk_ids TEXT[],
        trajectory_id TEXT,
        chunk_index INTEGER,
        chunk_count INTEGER,
        artifacts JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT '${DEFAULT_OWNER}';`);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunker_version TEXT;`);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT;`);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS dream_type TEXT;`);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS source_chunk_ids TEXT[];`);

    // Supersession tombstones (timestamp already serves as valid_at — no
    // valid_at column). invalid_at set = soft-invalidated; superseded_by names
    // the replacing trajectory. Partial index so live reads (invalid_at IS NULL)
    // never pay for the tombstones. Ships under SCHEMA_VERSION 2 (with Lane 1).
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS invalid_at TIMESTAMPTZ;`);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS superseded_by TEXT;`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_invalid_at_idx ON chunks (invalid_at) WHERE invalid_at IS NOT NULL;`);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        content_sha256 TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        embedding vector NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (content_sha256, embedding_model)
      );
    `);

    // Image caption cache, mirror of embedding_cache: keyed (image_sha256, model)
    // so a re-caption on the same model is a free hit and captions stay stable.
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS caption_cache (
        image_sha256 TEXT NOT NULL,
        model TEXT NOT NULL,
        caption TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (image_sha256, model)
      );
    `);

    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS trajectory_id TEXT;`);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunk_index INTEGER;`);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunk_count INTEGER;`);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS artifacts JSONB;`);

    await this.sql.unsafe(`
      ALTER TABLE chunks ADD COLUMN IF NOT EXISTS content_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
    `);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_content_tsv_idx ON chunks USING gin (content_tsv);`);

    await this.sql.unsafe(`
      CREATE INDEX IF NOT EXISTS chunks_embedding_idx
      ON chunks USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    `);

    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_repo_idx ON chunks (repo);`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_branch_idx ON chunks (branch);`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_tier_idx ON chunks (tier);`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_timestamp_idx ON chunks (timestamp);`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_trajectory_idx ON chunks (trajectory_id);`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_model_idx ON chunks (embedding_model, chunker_version);`);

    // Dream-layer fingerprint state. PK (owner, session_id, repo) so re-runs
    // upsert-on-conflict; records source ids, produced dream chunk ids, model.
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS dream_units (
        owner TEXT NOT NULL,
        session_id TEXT NOT NULL,
        repo TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL,
        source_chunk_ids TEXT[] NOT NULL,
        dream_chunk_ids TEXT[] NOT NULL DEFAULT '{}',
        model TEXT,
        synthesized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (owner, session_id, repo)
      );
    `);

    // Wiki-layer ingest ledger, mirror of dream_units. fingerprint = sha256 of
    // the unit's sorted dream-chunk ids; pages = slugs touched by this unit.
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS wiki_units (
        owner TEXT NOT NULL,
        session_id TEXT NOT NULL,
        repo TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL,
        source_chunk_ids TEXT[] NOT NULL,
        pages TEXT[] NOT NULL DEFAULT '{}',
        model TEXT,
        ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (owner, session_id, repo)
      );
    `);

    // Record the schema version so the next initialize() can take the fast path.
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await this.sql`
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', ${String(SCHEMA_VERSION)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;

    await this.assertEmbeddingDim();
  }

  // Guard against a chunks.embedding column whose declared dimension differs
  // from this backend's embeddingDim — a silent mismatch would make every
  // upsert/search fail deep inside pgvector with an opaque error. Runs on BOTH
  // the fast path and the full-DDL path. pgvector stores the declared dimension
  // directly in pg_attribute.atttypmod (no -4 header offset), so it IS the dim.
  private async assertEmbeddingDim(): Promise<void> {
    const [row] = await this.sql<Array<{ atttypmod: number }>>`
      SELECT atttypmod FROM pg_attribute
      WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'
    `;
    const actual = row?.atttypmod ?? -1;
    // -1 = dimensionless vector (shouldn't happen for chunks, which declares a
    // dim); only a positive, differing typmod is a real mismatch.
    if (actual > 0 && actual !== this.embeddingDim) {
      throw new Error(
        `Embedding dimension mismatch: chunks.embedding is vector(${actual}), but this backend is configured for ${this.embeddingDim} dims. ` +
          `Run \`engram backfill --re-embed\` to migrate the column and re-embed every chunk in place — non-destructive, so dream/wiki content is preserved. ` +
          `Or set embeddingProvider/embeddingModel/embeddingDim in your config to match the existing data (${actual} dims).`
      );
    }
  }

  // --- Embedding-provider migration (engram backfill --re-embed) -------------
  // These methods deliberately use this.sql WITHOUT calling initialize(): the
  // whole point of --re-embed is to alter chunks.embedding for a dim change, and
  // initialize()'s assertEmbeddingDim would throw on the very mismatch this fixes.

  // Declared dimension of chunks.embedding (pgvector stores the dim directly in
  // atttypmod), or null when the chunks table doesn't exist yet (nothing to
  // migrate — the caller should run a plain backfill first).
  async reembedColumnDim(): Promise<number | null> {
    const [exists] = await this.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM pg_class WHERE relname = 'chunks' AND relkind = 'r'
    `;
    if (Number(exists?.n ?? 0) === 0) return null;
    const [row] = await this.sql<Array<{ atttypmod: number }>>`
      SELECT atttypmod FROM pg_attribute
      WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'
    `;
    return row ? row.atttypmod : null;
  }

  // Total chunk rows (ALL owners, ALL tiers, incl. tombstones): the re-embed
  // sweep is owner-agnostic by design, and after a column swap every row's
  // embedding is NULL and must be repopulated.
  async reembedRowCount(): Promise<number> {
    const [r] = await this.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM chunks`;
    return Number(r?.n ?? 0);
  }

  // Total content chars across all chunks — feeds the OpenAI cost estimate
  // (tokens ≈ chars/4). Never reads or touches embeddings.
  async reembedEstimateChars(): Promise<number> {
    const [r] = await this.sql<Array<{ c: string }>>`SELECT COALESCE(SUM(LENGTH(content)), 0)::text AS c FROM chunks`;
    return Number(r?.c ?? 0);
  }

  // Rows still awaiting an embedding after the sweep — used to fail nonzero if
  // any chunk was left NULL.
  async reembedNullCount(): Promise<number> {
    const [r] = await this.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM chunks WHERE embedding IS NULL`;
    return Number(r?.n ?? 0);
  }

  // Swap chunks.embedding to a new dimension in one transaction: DROP COLUMN
  // (auto-drops the HNSW index, which references only this column) then re-ADD at
  // the target dim, then reset schema_meta so the next initialize() re-runs the
  // full DDL (recreating the HNSW index + re-stamping the version). Content and
  // every other column are untouched. The dim is interpolated into DDL, so it is
  // validated as a positive integer ≤ 4096 first.
  async migrateEmbeddingColumn(targetDim: number): Promise<void> {
    if (!Number.isInteger(targetDim) || targetDim <= 0 || targetDim > 4096) {
      throw new Error(`invalid target embedding dimension ${targetDim} (expected a positive integer ≤ 4096)`);
    }
    await this.sql.begin(async (tx) => {
      await tx.unsafe(`ALTER TABLE chunks DROP COLUMN embedding`);
      await tx.unsafe(`ALTER TABLE chunks ADD COLUMN embedding vector(${targetDim})`);
      await tx.unsafe(`UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'`);
    });
  }

  // Next batch of rows needing (re-)embedding, lowest id first. The predicate is
  // self-advancing: a row leaves the set once its embedding is written under the
  // target model, so the loop naturally terminates and resumes after a crash
  // (rows keep their content; only embedding is NULL). Covers BOTH a post-migration
  // sweep (every embedding NULL) and a same-dim model swap (embedding_model differs).
  async reembedFetchBatch(model: string, limit: number): Promise<Array<{ id: string; content: string }>> {
    const rows = await this.sql<Array<{ id: string; content: string }>>`
      SELECT id, content FROM chunks
      WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM ${model}
      ORDER BY id
      LIMIT ${limit}
    `;
    return rows.map((r) => ({ id: r.id, content: r.content }));
  }

  // Persist a batch of re-embeddings in one transaction. The ONLY columns written
  // are embedding + the model/dim stamps — content and metadata are never touched.
  async reembedWriteBatch(writes: Array<{ id: string; embedding: number[]; model: string }>): Promise<void> {
    if (writes.length === 0) return;
    await this.sql.begin(async (tx) => {
      for (const w of writes) {
        await tx`
          UPDATE chunks
          SET embedding = ${formatVector(w.embedding)},
              embedding_dim = ${w.embedding.length},
              model_id = ${w.model},
              embedding_model = ${w.model}
          WHERE id = ${w.id}
        `;
      }
    });
  }

  async insertRawEvents(events: RawEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const rows = events.map((e) => ({
      owner: e.owner ?? DEFAULT_OWNER,
      source: e.source,
      session_id: e.sessionId,
      content_sha256: e.contentSha256,
      occurred_at: e.occurredAt,
      payload: this.sql.json(e.payload as postgres.JSONValue),
    }));
    // Multi-row inserts, ~INSERT_BATCH rows/statement. RETURNING id + summing
    // row counts preserves the exact inserted-count contract across the
    // ON CONFLICT DO NOTHING dedupe (skipped rows don't RETURN).
    let inserted = 0;
    await this.sql.begin(async (tx) => {
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const slice = rows.slice(i, i + INSERT_BATCH);
        const ret = await tx`
          INSERT INTO raw_events ${tx(slice, 'owner', 'source', 'session_id', 'content_sha256', 'occurred_at', 'payload')}
          ON CONFLICT (content_sha256) DO NOTHING
          RETURNING id
        `;
        inserted += ret.length;
      }
    });
    return inserted;
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;

    // Reject the whole batch before any INSERT if any embedding is the wrong
    // length — a mismatched vector would fail opaquely inside pgvector mid-batch.
    for (const c of chunks) {
      if (c.embedding.length !== this.embeddingDim) {
        throw new Error(
          `upsert rejected: chunk ${c.id} has embedding length ${c.embedding.length}, expected ${this.embeddingDim}. ` +
            `No rows were written. Re-embed with the configured model, or fix embeddingDim/embeddingModel to match.`
        );
      }
    }

    // Dedupe by id, first occurrence wins — one batch can legitimately carry the
    // same chunk twice (identical repeated user turns hash to the same
    // trajectoryId and chunk ids). DO NOTHING silently skipped the duplicate;
    // DO UPDATE raises "cannot affect row a second time" on it.
    const seen = new Set<string>();
    const unique = chunks.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

    const rows = unique.map((c) => {
      // Stamp the model that actually embedded (may differ after a fallback latch).
      const model = c.metadata.embeddingModel ?? this.embeddingModel;
      return {
        id: c.id,
        embedding: formatVector(c.embedding),
        content: c.content,
        model_id: model,
        embedding_dim: c.embedding.length,
        owner: c.metadata.owner ?? DEFAULT_OWNER,
        chunker_version: this.chunkerVersion,
        embedding_model: model,
        repo: c.metadata.repo,
        branch: c.metadata.branch,
        timestamp: c.metadata.timestamp,
        file_paths: c.metadata.filePaths,
        exit_code: c.metadata.exitCode,
        session_id: c.metadata.sessionId,
        cwd: c.metadata.cwd,
        tier: c.metadata.tier,
        dream_type: c.metadata.dreamType ?? null,
        source_chunk_ids: c.metadata.sourceChunkIds ?? null,
        trajectory_id: c.metadata.trajectoryId ?? null,
        chunk_index: c.metadata.chunkIndex ?? null,
        chunk_count: c.metadata.chunkCount ?? null,
        // JSONB: wrap non-null with sql.json so the multi-row helper types it as
        // json rather than a Postgres array literal.
        artifacts:
          c.metadata.artifacts && c.metadata.artifacts.length > 0
            ? this.sql.json(c.metadata.artifacts as unknown as postgres.JSONValue)
            : null,
      };
    });

    // Batched multi-row INSERTs (~INSERT_BATCH rows/statement) in one tx.
    // postgres.js coerces the formatVector() text into the vector column and
    // handles text[]/jsonb/nulls per-column (proven in live.test). On an id
    // conflict chunker_version is restamped AND any supersession tombstone is
    // cleared (invalid_at/superseded_by → NULL): ids are content-derived (hash
    // of trajectoryId+index+text), so a conflicting row holds the exact text the
    // current chunker just produced — it IS a current-version chunk, the reindex
    // sweep must not delete it as stale, and knowledge that reverts to a
    // previously-invalidated state must resurrect (else it stays invisible
    // forever). Every other column keeps DO NOTHING semantics (embedding/model
    // stay atomic with each other).
    const cols = [
      'id', 'embedding', 'content', 'model_id', 'embedding_dim',
      'owner', 'chunker_version', 'embedding_model',
      'repo', 'branch', 'timestamp', 'file_paths', 'exit_code',
      'session_id', 'cwd', 'tier', 'dream_type', 'source_chunk_ids',
      'trajectory_id', 'chunk_index', 'chunk_count', 'artifacts',
    ] as const;
    await this.sql.begin(async (tx) => {
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const slice = rows.slice(i, i + INSERT_BATCH);
        await tx`
          INSERT INTO chunks ${tx(slice, ...cols)}
          ON CONFLICT (id) DO UPDATE SET
            chunker_version = EXCLUDED.chunker_version,
            invalid_at = NULL,
            superseded_by = NULL
        `;
      }
    });
  }

  async getCachedEmbeddings(shas: string[], model: string): Promise<Map<string, number[]>> {
    if (shas.length === 0) return new Map();
    const rows = await this.sql<Array<{ content_sha256: string; embedding: string }>>`
      SELECT content_sha256, embedding::text AS embedding
      FROM embedding_cache
      WHERE embedding_model = ${model} AND content_sha256 IN ${this.sql(shas)}
    `;
    const map = new Map<string, number[]>();
    for (const r of rows) map.set(r.content_sha256, parseVector(r.embedding));
    return map;
  }

  async putCachedEmbeddings(
    entries: Array<{ sha: string; embedding: number[] }>,
    model: string
  ): Promise<void> {
    if (entries.length === 0) return;
    const rows = entries.map((e) => ({
      content_sha256: e.sha,
      embedding_model: model,
      embedding: formatVector(e.embedding),
    }));
    // Batched multi-row INSERTs. embedding_cache.embedding is a dimensionless
    // vector (model-keyed), so no dim guard here.
    await this.sql.begin(async (tx) => {
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const slice = rows.slice(i, i + INSERT_BATCH);
        await tx`
          INSERT INTO embedding_cache ${tx(slice, 'content_sha256', 'embedding_model', 'embedding')}
          ON CONFLICT (content_sha256, embedding_model) DO NOTHING
        `;
      }
    });
  }

  async getCachedCaptions(shas: string[], model: string): Promise<Map<string, string>> {
    if (shas.length === 0) return new Map();
    const rows = await this.sql<Array<{ image_sha256: string; caption: string }>>`
      SELECT image_sha256, caption
      FROM caption_cache
      WHERE model = ${model} AND image_sha256 IN ${this.sql(shas)}
    `;
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.image_sha256, r.caption);
    return map;
  }

  async putCachedCaptions(entries: Array<{ sha: string; caption: string }>, model: string): Promise<void> {
    if (entries.length === 0) return;
    const rows = entries.map((e) => ({ image_sha256: e.sha, model, caption: e.caption }));
    await this.sql.begin(async (tx) => {
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const slice = rows.slice(i, i + INSERT_BATCH);
        await tx`
          INSERT INTO caption_cache ${tx(slice, 'image_sha256', 'model', 'caption')}
          ON CONFLICT (image_sha256, model) DO NOTHING
        `;
      }
    });
  }

  // Single Row→Chunk mapping shared by search/getTrajectory/getUnitChunks/
  // recentDreamChunks. Nullable text columns coalesce to '' (metadata types them
  // non-null; real ingested chunks always set them). embedding is always []
  // — reads never rehydrate the vector. owner is included only when the query
  // SELECTed it (undefined otherwise), preserving prior per-call-site behavior.
  private rowToChunk(row: ChunkRow): Chunk {
    return {
      id: row.id,
      embedding: [],
      content: row.content,
      metadata: {
        repo: row.repo ?? '',
        branch: row.branch ?? '',
        timestamp: row.timestamp as Date,
        filePaths: row.file_paths ?? [],
        exitCode: row.exit_code ?? null,
        sessionId: row.session_id ?? '',
        cwd: row.cwd ?? '',
        tier: row.tier,
        owner: row.owner ?? undefined,
        dreamType: row.dream_type ?? undefined,
        sourceChunkIds: row.source_chunk_ids ?? undefined,
        trajectoryId: row.trajectory_id ?? undefined,
        chunkIndex: row.chunk_index ?? undefined,
        chunkCount: row.chunk_count ?? undefined,
        artifacts: row.artifacts ?? undefined,
        invalidAt: row.invalid_at ?? undefined,
        supersededBy: row.superseded_by ?? undefined,
      },
    };
  }

  async search(queryEmbedding: number[], queryText: string, filters: SearchFilters): Promise<SearchResult[]> {
    const vec = formatVector(queryEmbedding);
    // Clamp to a finite positive integer: limit comes from CLI input (Number()
    // can yield NaN/Infinity) and pool is interpolated into raw SQL below.
    const limit = Number.isFinite(filters.limit) ? Math.max(1, Math.floor(filters.limit as number)) : 5;
    const tiers = tiersFor(filters.tier);
    const { vectorWeight, keywordWeight, timeDecayHalfLifeDays, recencyWeight, recencyHalfLifeDays, importanceWeight } =
      this.scoring;
    const includeSuperseded = filters.includeSuperseded ?? false;
    const pool = Math.max(CANDIDATE_POOL, limit);
    const keywordPool = Math.max(KEYWORD_POOL, limit);

    type Row = {
      id: string;
      content: string;
      repo: string;
      branch: string;
      timestamp: Date;
      file_paths: string[];
      exit_code: number | null;
      session_id: string;
      cwd: string;
      tier: 'raw' | 'dream' | 'wiki';
      dream_type: string | null;
      source_chunk_ids: string[] | null;
      trajectory_id: string | null;
      chunk_index: number | null;
      chunk_count: number | null;
      artifacts: Artifact[] | null;
      invalid_at: Date | null;
      superseded_by: string | null;
      similarity: number;
      keyword_rank: number;
      combined: number;
    };

    // Two arms feed the candidate pool, then both signals score every candidate
    // and re-rank by the weighted combination. Keyword rank uses ts_rank_cd with
    // normalization flag 32 → rank/(rank+1), i.e. [0,1). The additive sum also
    // carries a recency prior (exp half-life over recencyHalfLifeDays, [0,1]) and
    // a tier-importance prior (TIER_PRIORS, [0,1]); both weights default off-ish.
    // Time-decay multiplies the whole combined score by exp(-age_days / halfLife)
    // when enabled. Invalidated (tombstoned) rows are excluded from both arms
    // unless filters.includeSuperseded.
    //   - Vector arm: top-`pool` by cosine distance (HNSW).
    //   - Keyword arm: top-`keywordPool` by ts_rank_cd where content_tsv matches the
    //     tsquery (GIN). A stopword-only query yields an empty tsquery: `@@` is then
    //     false for every row, so the arm contributes nothing (no match / no error).
    // The same filter block gates both arms. Distance and rank are recomputed over
    // the unioned candidates so keyword-arm rows get a similarity and vice versa.
    const query = (sql: postgres.TransactionSql | ReturnType<typeof postgres>) => sql<Row[]>`
      WITH vector_arm AS (
        SELECT id
        FROM chunks
        WHERE
          (${filters.repo ?? null}::text IS NULL OR repo = ${filters.repo ?? null})
          AND (${filters.branch ?? null}::text IS NULL OR branch = ${filters.branch ?? null})
          AND (${filters.since ?? null}::timestamptz IS NULL OR timestamp >= ${filters.since ?? null})
          AND (${tiers}::text[] IS NULL OR tier = ANY(${tiers}::text[]))
          AND (${filters.exitCode ?? null}::int IS NULL OR exit_code = ${filters.exitCode ?? null})
          AND (${filters.owner ?? null}::text IS NULL OR owner = ${filters.owner ?? null})
          AND (${includeSuperseded}::boolean OR invalid_at IS NULL)
        ORDER BY embedding <=> ${vec}::vector ASC
        LIMIT ${pool}
      ),
      keyword_arm AS (
        SELECT id
        FROM chunks
        WHERE
          content_tsv @@ websearch_to_tsquery('english', ${queryText})
          AND (${filters.repo ?? null}::text IS NULL OR repo = ${filters.repo ?? null})
          AND (${filters.branch ?? null}::text IS NULL OR branch = ${filters.branch ?? null})
          AND (${filters.since ?? null}::timestamptz IS NULL OR timestamp >= ${filters.since ?? null})
          AND (${tiers}::text[] IS NULL OR tier = ANY(${tiers}::text[]))
          AND (${filters.exitCode ?? null}::int IS NULL OR exit_code = ${filters.exitCode ?? null})
          AND (${filters.owner ?? null}::text IS NULL OR owner = ${filters.owner ?? null})
          AND (${includeSuperseded}::boolean OR invalid_at IS NULL)
        ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('english', ${queryText}), 32) DESC
        LIMIT ${keywordPool}
      ),
      candidate_ids AS (
        SELECT id FROM vector_arm
        UNION
        SELECT id FROM keyword_arm
      ),
      scored AS (
        SELECT
          c.id, c.content, c.repo, c.branch, c.timestamp, c.file_paths,
          c.exit_code, c.session_id, c.cwd, c.tier, c.dream_type, c.source_chunk_ids,
          c.trajectory_id, c.chunk_index, c.chunk_count, c.artifacts,
          c.invalid_at, c.superseded_by,
          (1 - (c.embedding <=> ${vec}::vector)) AS similarity,
          ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', ${queryText}), 32) AS keyword_rank
        FROM chunks c
        JOIN candidate_ids ci ON ci.id = c.id
      )
      SELECT
        id, content, repo, branch, timestamp, file_paths,
        exit_code, session_id, cwd, tier, dream_type, source_chunk_ids,
        trajectory_id, chunk_index, chunk_count, artifacts,
        invalid_at, superseded_by,
        similarity, keyword_rank,
        (
          ${vectorWeight}::float * similarity
          + ${keywordWeight}::float * keyword_rank
          + ${recencyWeight}::float * CASE
              WHEN ${recencyHalfLifeDays}::float > 0 AND timestamp IS NOT NULL
              THEN LEAST(1.0, exp(-ln(2.0) * (EXTRACT(EPOCH FROM (NOW() - timestamp)) / 86400.0) / ${recencyHalfLifeDays}::float))
              ELSE 0
            END
          + ${importanceWeight}::float * CASE tier
              WHEN 'wiki' THEN ${TIER_PRIORS.wiki}::float
              WHEN 'dream' THEN ${TIER_PRIORS.dream}::float
              ELSE ${TIER_PRIORS.raw}::float
            END
        ) * CASE
              WHEN ${timeDecayHalfLifeDays}::float > 0 AND timestamp IS NOT NULL
              THEN exp(-(EXTRACT(EPOCH FROM (NOW() - timestamp)) / 86400.0) / ${timeDecayHalfLifeDays}::float)
              ELSE 1
            END AS combined
      FROM scored
      ORDER BY combined DESC NULLS LAST
      LIMIT ${limit}
    `;

    // Exhaustive mode forces a seq scan (exact cosine) so a selective owner
    // filter can't be starved by the HNSW candidate set. Otherwise raise
    // hnsw.ef_search (default 40) to the pool size so the index scan can return
    // enough candidates. SET LOCAL scopes both to their transaction.
    const rows = filters.exhaustive
      ? await this.sql.begin(async (tx) => {
          await tx`SET LOCAL enable_indexscan = off`;
          await tx`SET LOCAL enable_bitmapscan = off`;
          return query(tx);
        })
      : await this.sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL hnsw.ef_search = ${Math.min(1000, pool)}`);
          return query(tx);
        });

    return rows.map((r) => ({
      similarity: r.similarity,
      keywordRank: r.keyword_rank,
      combined: r.combined,
      chunk: this.rowToChunk(r),
    }));
  }

  // Live chunks only: this feeds wiki candidate-page content to the LLM,
  // syncPageToIndex's stale computation (live − new is exactly what should be
  // invalidated), and the UI trajectory viewer — all want live rows.
  async getTrajectory(trajectoryId: string): Promise<Chunk[]> {
    const rows = await this.sql<ChunkRow[]>`
      SELECT
        id, content, repo, branch, timestamp, file_paths,
        exit_code, session_id, cwd, tier, dream_type, source_chunk_ids,
        trajectory_id, chunk_index, chunk_count, artifacts
      FROM chunks
      WHERE trajectory_id = ${trajectoryId}
        AND invalid_at IS NULL
      ORDER BY chunk_index ASC NULLS LAST
    `;
    return rows.map((r) => this.rowToChunk(r));
  }

  async count(): Promise<number> {
    const [row] = await this.sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count FROM chunks WHERE invalid_at IS NULL
    `;
    return Number(row.count);
  }

  // --- Artifacts backfill sweep ---------------------------------------------
  // content_sha256 == trajectoryId (pipeline stamps it), and the payload is the
  // full Trajectory. Used by `engram backfill --artifacts` to re-derive artifacts
  // for chunks already ingested (upsert is ON CONFLICT DO NOTHING, so a re-run
  // would no-op them).

  async rawTrajectoriesForArtifacts(source: string): Promise<Array<{ trajectoryId: string; payload: Trajectory }>> {
    const rows = await this.sql<Array<{ content_sha256: string; payload: Trajectory }>>`
      SELECT content_sha256, payload FROM raw_events WHERE source = ${source}
    `;
    return rows.map((r) => ({ trajectoryId: r.content_sha256, payload: r.payload }));
  }

  // Attach artifacts to a trajectory's raw chunks. Never touches embeddings/content.
  async setChunkArtifacts(trajectoryId: string, artifacts: Artifact[]): Promise<number> {
    const res = await this.sql`
      UPDATE chunks
      SET artifacts = ${this.sql.json(artifacts as unknown as postgres.JSONValue)}
      WHERE trajectory_id = ${trajectoryId} AND tier = 'raw'
    `;
    return res.count;
  }

  // --- DreamStore -----------------------------------------------------------

  async listSynthesisUnits(opts: { owner: string; repo?: string; since?: Date; sessionId?: string }): Promise<SynthesisUnit[]> {
    return this.aggregateUnits('raw', opts.owner, { repo: opts.repo, since: opts.since, sessionId: opts.sessionId });
  }

  // Group chunks of a tier by (session_id, repo) into synthesis units. Shared by
  // the dream layer (tier='raw') and the wiki layer (tier='dream'). Invalidated
  // chunks are excluded — equivalent to the old post-delete state, so the unit
  // fingerprints (sha256 of the surviving id set) match what deletion produced.
  private async aggregateUnits(
    tier: 'raw' | 'dream',
    owner: string,
    opts: { repo?: string; since?: Date; sessionId?: string }
  ): Promise<SynthesisUnit[]> {
    const rows = await this.sql<
      Array<{ session_id: string; repo: string; chunk_ids: string[]; total_chars: number; last_ts: Date }>
    >`
      SELECT
        session_id,
        COALESCE(repo, '') AS repo,
        array_agg(id ORDER BY id) AS chunk_ids,
        SUM(LENGTH(content))::int AS total_chars,
        MAX(timestamp) AS last_ts
      FROM chunks
      WHERE tier = ${tier}
        AND owner = ${owner}
        AND invalid_at IS NULL
        AND (${opts.repo ?? null}::text IS NULL OR repo = ${opts.repo ?? null})
        AND (${opts.sessionId ?? null}::text IS NULL OR session_id = ${opts.sessionId ?? null})
      GROUP BY session_id, COALESCE(repo, '')
      HAVING (${opts.since ?? null}::timestamptz IS NULL OR MAX(timestamp) >= ${opts.since ?? null})
      ORDER BY MAX(timestamp) DESC
    `;
    return rows.map((r) => ({
      sessionId: r.session_id,
      repo: r.repo,
      chunkIds: r.chunk_ids,
      totalChars: r.total_chars,
      lastTimestamp: r.last_ts,
    }));
  }

  async getUnitChunks(owner: string, sessionId: string, repo: string, tier: 'raw' | 'dream' = 'raw'): Promise<Chunk[]> {
    // SELECT the real columns (was fabricating branch:''/filePaths:[]/cwd:''/
    // exitCode:null) and route through rowToChunk. SACRED: the returned chunk-id
    // SET (and its order) is unchanged — dream fingerprintOf / pageFingerprint
    // depend on it. Only the metadata is now real; ids/order are identical.
    // Invalidated chunks are filtered out, and that is CORRECT for the
    // fingerprints computed from this id set: it is exactly equivalent to the
    // old post-delete state (invalidation replaced deletion 1:1).
    const rows = await this.sql<ChunkRow[]>`
      SELECT
        id, content, repo, branch, timestamp, file_paths,
        exit_code, session_id, cwd, tier, dream_type, source_chunk_ids,
        trajectory_id, chunk_index, chunk_count, artifacts
      FROM chunks
      WHERE tier = ${tier} AND owner = ${owner} AND session_id = ${sessionId}
        AND COALESCE(repo, '') = ${repo}
        AND invalid_at IS NULL
      ORDER BY timestamp ASC NULLS LAST, chunk_index ASC NULLS LAST
    `;
    return rows.map((r) => this.rowToChunk(r));
  }

  async getDreamUnits(owner: string): Promise<DreamUnitRow[]> {
    const rows = await this.sql<
      Array<{ owner: string; session_id: string; repo: string; fingerprint: string; source_chunk_ids: string[]; dream_chunk_ids: string[]; model: string | null }>
    >`
      SELECT owner, session_id, repo, fingerprint, source_chunk_ids, dream_chunk_ids, model
      FROM dream_units WHERE owner = ${owner}
    `;
    return rows.map((r) => ({
      owner: r.owner,
      sessionId: r.session_id,
      repo: r.repo,
      fingerprint: r.fingerprint,
      sourceChunkIds: r.source_chunk_ids,
      dreamChunkIds: r.dream_chunk_ids,
      model: r.model ?? '',
    }));
  }

  async upsertDreamUnit(row: DreamUnitRow): Promise<void> {
    await this.sql`
      INSERT INTO dream_units (owner, session_id, repo, fingerprint, source_chunk_ids, dream_chunk_ids, model, synthesized_at)
      VALUES (
        ${row.owner}, ${row.sessionId}, ${row.repo}, ${row.fingerprint},
        ${row.sourceChunkIds as string[]}, ${row.dreamChunkIds as string[]}, ${row.model}, NOW()
      )
      ON CONFLICT (owner, session_id, repo) DO UPDATE SET
        fingerprint = EXCLUDED.fingerprint,
        source_chunk_ids = EXCLUDED.source_chunk_ids,
        dream_chunk_ids = EXCLUDED.dream_chunk_ids,
        model = EXCLUDED.model,
        synthesized_at = NOW()
    `;
  }

  // Delete chunks by id, defensively scoped by owner + tier so a row of another
  // tier or owner can never be touched even on a caller bug.
  async deleteChunksByIds(ids: string[], owner: string, tier: string): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.sql`
      DELETE FROM chunks
      WHERE id = ANY(${ids as string[]}) AND tier = ${tier} AND owner = ${owner}
    `;
    return res.count;
  }

  // Soft-invalidate chunks (knowledge-level replacement). Owner+tier-scoped
  // defensively like deleteChunksByIds. `AND invalid_at IS NULL` makes it
  // idempotent and preserves the first tombstone's timestamp/superseded_by.
  async invalidateChunks(ids: string[], owner: string, tier: string, supersededBy: string | null): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.sql`
      UPDATE chunks
      SET invalid_at = NOW(), superseded_by = ${supersededBy}
      WHERE id = ANY(${ids as string[]}) AND tier = ${tier} AND owner = ${owner} AND invalid_at IS NULL
    `;
    return res.count;
  }

  // tier='dream' wrapper kept for the dream layer's call site.
  async invalidateDreamChunks(ids: string[], owner: string, supersededBy: string | null): Promise<number> {
    return this.invalidateChunks(ids, owner, 'dream', supersededBy);
  }

  // --- WikiLedger ------------------------------------------------------------

  async listDreamUnitsAsUnits(owner: string, opts: { repo?: string; since?: Date } = {}): Promise<SynthesisUnit[]> {
    return this.aggregateUnits('dream', owner, opts);
  }

  async listWikiChunkIds(owner: string): Promise<Array<{ id: string; trajectoryId: string | null }>> {
    const rows = await this.sql<Array<{ id: string; trajectory_id: string | null }>>`
      SELECT id, trajectory_id FROM chunks
      WHERE tier = 'wiki' AND owner = ${owner} AND invalid_at IS NULL
    `;
    return rows.map((r) => ({ id: r.id, trajectoryId: r.trajectory_id }));
  }

  // Subset of the given ids that exist as chunks of the given tier — used by
  // wiki lint's broken-provenance check (sources must be real dream chunks).
  // Deliberately UNFILTERED by invalid_at: provenance requires the source rows
  // to merely EXIST; an invalidated source is still a real chunk, not broken.
  async existingChunkIds(ids: string[], tier: string): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.sql<Array<{ id: string }>>`
      SELECT id FROM chunks WHERE tier = ${tier} AND id = ANY(${ids as string[]})
    `;
    return new Set(rows.map((r) => r.id));
  }

  // --- WikiEvidenceStore -----------------------------------------------------

  // Dream units joined to their wiki-ledger fingerprint, prefiltered in SQL to
  // those synthesized before `cutoff`. Rows only: the pending-unit decision
  // (fingerprint compare + staleness) is wiki lint's rule, applied by wiki's
  // pendingWikiUnits — storage stays free of wiki rules.
  //   NOTE: dream_units.fingerprint is sha256(sorted RAW ids) and
  //   wiki_units.fingerprint is sha256(sorted DREAM ids) — different id domains,
  //   never equal even when in sync. The comparable dream signal is
  //   sha256(sorted dream_units.dream_chunk_ids), which is what ingest hashes.
  async dreamUnitsWithWikiFingerprint(owner: string, cutoff: Date): Promise<DreamUnitWikiRow[]> {
    const rows = await this.sql<
      Array<{ session_id: string; repo: string; dream_chunk_ids: string[]; wiki_fingerprint: string | null; synthesized_at: Date }>
    >`
      SELECT d.session_id, d.repo, d.dream_chunk_ids,
             w.fingerprint AS wiki_fingerprint, d.synthesized_at
      FROM dream_units d
      LEFT JOIN wiki_units w
        ON w.owner = d.owner AND w.session_id = d.session_id AND w.repo = d.repo
      WHERE d.owner = ${owner} AND d.synthesized_at < ${cutoff}
    `;
    return rows.map((r) => ({
      sessionId: r.session_id,
      repo: r.repo,
      dreamChunkIds: r.dream_chunk_ids,
      wikiFingerprint: r.wiki_fingerprint,
      synthesizedAt: r.synthesized_at,
    }));
  }

  // Distinct sessions + first/last timestamp over a page's dream source chunks.
  // Deliberately UNFILTERED by invalid_at: this is an evidence/provenance
  // roll-up over source ids — same existence semantics as existingChunkIds.
  async wikiPageEvidence(sourceIds: string[]): Promise<WikiPageEvidence> {
    if (sourceIds.length === 0) return { sessionCount: 0, firstSeen: null, lastSeen: null };
    const [row] = await this.sql<Array<{ sessions: string; first: Date | null; last: Date | null }>>`
      SELECT COUNT(DISTINCT session_id)::text AS sessions,
             MIN(timestamp) AS first, MAX(timestamp) AS last
      FROM chunks WHERE id = ANY(${sourceIds as string[]})
    `;
    return { sessionCount: Number(row?.sessions ?? 0), firstSeen: row?.first ?? null, lastSeen: row?.last ?? null };
  }

  async getWikiUnits(owner: string): Promise<WikiUnitRow[]> {
    const rows = await this.sql<
      Array<{ owner: string; session_id: string; repo: string; fingerprint: string; source_chunk_ids: string[]; pages: string[]; model: string | null }>
    >`
      SELECT owner, session_id, repo, fingerprint, source_chunk_ids, pages, model
      FROM wiki_units WHERE owner = ${owner}
    `;
    return rows.map((r) => ({
      owner: r.owner,
      sessionId: r.session_id,
      repo: r.repo,
      fingerprint: r.fingerprint,
      sourceChunkIds: r.source_chunk_ids,
      pages: r.pages,
      model: r.model ?? '',
    }));
  }

  async upsertWikiUnit(row: WikiUnitRow): Promise<void> {
    await this.sql`
      INSERT INTO wiki_units (owner, session_id, repo, fingerprint, source_chunk_ids, pages, model, ingested_at)
      VALUES (
        ${row.owner}, ${row.sessionId}, ${row.repo}, ${row.fingerprint},
        ${row.sourceChunkIds as string[]}, ${row.pages as string[]}, ${row.model}, NOW()
      )
      ON CONFLICT (owner, session_id, repo) DO UPDATE SET
        fingerprint = EXCLUDED.fingerprint,
        source_chunk_ids = EXCLUDED.source_chunk_ids,
        pages = EXCLUDED.pages,
        model = EXCLUDED.model,
        ingested_at = NOW()
    `;
  }

  // --- ContextStore ---------------------------------------------------------

  async wikiPagesForRepo(
    owner: string,
    repo: string,
    limit: number
  ): Promise<Array<{ slug: string; matchCount: number; lastChunkAt: Date | null; excerpt: string }>> {
    const rows = await this.sql<Array<{ slug: string; match_count: string; last_ts: Date | null; excerpt: string | null }>>`
      SELECT
        regexp_replace(w.trajectory_id, '^wiki:', '') AS slug,
        count(DISTINCT d.id) AS match_count,
        max(w.timestamp) AS last_ts,
        (array_agg(w.content ORDER BY w.chunk_index ASC NULLS LAST))[1] AS excerpt
      FROM chunks w
      JOIN chunks d
        ON d.tier = 'dream' AND d.owner = w.owner AND d.repo = ${repo} AND d.id = ANY(w.source_chunk_ids)
        AND d.invalid_at IS NULL
      WHERE w.tier = 'wiki' AND w.owner = ${owner} AND w.invalid_at IS NULL
      GROUP BY w.trajectory_id
      ORDER BY match_count DESC, max(w.timestamp) DESC, w.trajectory_id ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      slug: r.slug,
      matchCount: Number(r.match_count),
      lastChunkAt: r.last_ts,
      excerpt: r.excerpt ?? '',
    }));
  }

  async recentDreamChunks(owner: string, repo: string, since: Date, types: string[], limit: number): Promise<Chunk[]> {
    // repo/owner/tier are fixed by the WHERE clause, so selecting them yields the
    // same values the old code stamped from params; rowToChunk fills the rest.
    const rows = await this.sql<ChunkRow[]>`
      SELECT id, content, repo, timestamp, session_id, tier, owner, dream_type, trajectory_id, artifacts
      FROM chunks
      WHERE tier = 'dream' AND owner = ${owner} AND repo = ${repo}
        AND timestamp >= ${since} AND dream_type = ANY(${types})
        AND invalid_at IS NULL
      ORDER BY timestamp DESC, id ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => this.rowToChunk(r));
  }

  async keywordSearchChunks(
    owner: string,
    tier: string,
    queryText: string,
    limit: number
  ): Promise<Array<{ trajectoryId: string | null; rank: number; content: string }>> {
    const rows = await this.sql<Array<{ trajectory_id: string | null; rank: number; content: string }>>`
      SELECT trajectory_id, content,
        ts_rank_cd(content_tsv, websearch_to_tsquery('english', ${queryText}), 32) AS rank
      FROM chunks
      WHERE tier = ${tier} AND owner = ${owner}
        AND content_tsv @@ websearch_to_tsquery('english', ${queryText})
        AND invalid_at IS NULL
      ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('english', ${queryText}), 32) DESC, trajectory_id ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({ trajectoryId: r.trajectory_id, rank: Number(r.rank), content: r.content }));
  }

  // Sweep an owner's stale-chunker chunks of one tier after a reindex pass.
  // IS DISTINCT FROM also catches NULL chunker_version (pre-stamp rows).
  async deleteChunksByStaleVersion(owner: string, tier: string, currentVersion: string): Promise<number> {
    const res = await this.sql`
      DELETE FROM chunks
      WHERE owner = ${owner} AND tier = ${tier}
        AND chunker_version IS DISTINCT FROM ${currentVersion}
    `;
    return res.count;
  }

  // Retract every chunk + raw event + dream unit for an owner, atomically. Exact
  // match: the store-of-record and its index both go, so an owner's data leaves
  // no trace.
  async deleteByOwner(owner: string): Promise<{ chunks: number; rawEvents: number }> {
    return this.sql.begin(async (tx) => {
      const c = await tx`DELETE FROM chunks WHERE owner = ${owner}`;
      const r = await tx`DELETE FROM raw_events WHERE owner = ${owner}`;
      await tx`DELETE FROM dream_units WHERE owner = ${owner}`;
      await tx`DELETE FROM wiki_units WHERE owner = ${owner}`;
      return { chunks: c.count, rawEvents: r.count };
    });
  }

  // Same, for every owner sharing a prefix (e.g. 'bench:' → 'bench:%').
  async deleteByOwnerPrefix(prefix: string): Promise<{ chunks: number; rawEvents: number }> {
    const like = prefix + '%';
    return this.sql.begin(async (tx) => {
      const c = await tx`DELETE FROM chunks WHERE owner LIKE ${like}`;
      const r = await tx`DELETE FROM raw_events WHERE owner LIKE ${like}`;
      await tx`DELETE FROM dream_units WHERE owner LIKE ${like}`;
      await tx`DELETE FROM wiki_units WHERE owner LIKE ${like}`;
      return { chunks: c.count, rawEvents: r.count };
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

function formatVector(v: number[]): string {
  return '[' + v.join(',') + ']';
}

function parseVector(s: string): number[] {
  return s.slice(1, -1).split(',').map(Number);
}
