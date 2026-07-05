import postgres from 'postgres';
import type { Artifact, Chunk, RawEvent, ScoringConfig, SearchFilters, SearchResult, Trajectory } from '../types/index.ts';
import type { ContextStore, DreamStore, DreamUnitRow, PendingUnit, SynthesisUnit, VectorBackend, WikiEvidenceStore, WikiLedger, WikiPageEvidence, WikiUnitRow } from './backend.ts';
import { pendingUnitsFrom } from '../wiki/lint.ts';

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
};

// Two-arm candidate pool re-ranked by hybrid score: vector top-100 (HNSW) UNION
// keyword top-50 (GIN ts_rank_cd), so an exact-identifier match outside the
// vector neighbourhood still surfaces. See search/README.md.
const CANDIDATE_POOL = 100;
const KEYWORD_POOL = 50;

export class PgVectorBackend implements VectorBackend, DreamStore, WikiLedger, WikiEvidenceStore, ContextStore {
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
    scoring: ScoringConfig = DEFAULT_SCORING
  ) {
    // SSL is derived from the URL (e.g. ?sslmode=require for Neon).
    // Local Postgres URLs without sslmode connect without TLS.
    this.sql = postgres(databaseUrl, { prepare: false, onnotice: () => {} });
    this.embeddingDim = embeddingDim;
    this.embeddingModel = embeddingModel;
    this.chunkerVersion = chunkerVersion;
    this.scoring = scoring;
  }

  async initialize(): Promise<void> {
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

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        content_sha256 TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        embedding vector NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (content_sha256, embedding_model)
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
  }

  async insertRawEvents(events: RawEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    let inserted = 0;
    for (const e of events) {
      const rows = await this.sql`
        INSERT INTO raw_events (owner, source, session_id, content_sha256, occurred_at, payload)
        VALUES (
          ${e.owner ?? DEFAULT_OWNER}, ${e.source}, ${e.sessionId},
          ${e.contentSha256}, ${e.occurredAt}, ${this.sql.json(e.payload as postgres.JSONValue)}
        )
        ON CONFLICT (content_sha256) DO NOTHING
        RETURNING id
      `;
      inserted += rows.length;
    }
    return inserted;
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const rows = chunks.map((c) => {
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
        artifacts: c.metadata.artifacts && c.metadata.artifacts.length > 0 ? c.metadata.artifacts : null,
      };
    });

    for (const r of rows) {
      await this.sql`
        INSERT INTO chunks (
          id, embedding, content, model_id, embedding_dim,
          owner, chunker_version, embedding_model,
          repo, branch, timestamp, file_paths, exit_code,
          session_id, cwd, tier, dream_type, source_chunk_ids,
          trajectory_id, chunk_index, chunk_count, artifacts
        ) VALUES (
          ${r.id}, ${r.embedding}::vector, ${r.content}, ${r.model_id}, ${r.embedding_dim},
          ${r.owner}, ${r.chunker_version}, ${r.embedding_model},
          ${r.repo}, ${r.branch}, ${r.timestamp}, ${r.file_paths as string[]}, ${r.exit_code},
          ${r.session_id}, ${r.cwd}, ${r.tier}, ${r.dream_type}, ${r.source_chunk_ids as string[] | null},
          ${r.trajectory_id}, ${r.chunk_index}, ${r.chunk_count},
          ${r.artifacts === null ? null : this.sql.json(r.artifacts as unknown as postgres.JSONValue)}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
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
    for (const e of entries) {
      await this.sql`
        INSERT INTO embedding_cache (content_sha256, embedding_model, embedding)
        VALUES (${e.sha}, ${model}, ${formatVector(e.embedding)}::vector)
        ON CONFLICT (content_sha256, embedding_model) DO NOTHING
      `;
    }
  }

  async search(queryEmbedding: number[], queryText: string, filters: SearchFilters): Promise<SearchResult[]> {
    const vec = formatVector(queryEmbedding);
    // Clamp to a finite positive integer: limit comes from CLI input (Number()
    // can yield NaN/Infinity) and pool is interpolated into raw SQL below.
    const limit = Number.isFinite(filters.limit) ? Math.max(1, Math.floor(filters.limit as number)) : 5;
    const tiers = tiersFor(filters.tier);
    const { vectorWeight, keywordWeight, timeDecayHalfLifeDays } = this.scoring;
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
      similarity: number;
      keyword_rank: number;
      combined: number;
    };

    // Two arms feed the candidate pool, then both signals score every candidate
    // and re-rank by the weighted combination. Keyword rank uses ts_rank_cd with
    // normalization flag 32 → rank/(rank+1), i.e. [0,1). Time-decay multiplies the
    // combined score by exp(-age_days / halfLife) when enabled.
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
          (1 - (c.embedding <=> ${vec}::vector)) AS similarity,
          ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', ${queryText}), 32) AS keyword_rank
        FROM chunks c
        JOIN candidate_ids ci ON ci.id = c.id
      )
      SELECT
        id, content, repo, branch, timestamp, file_paths,
        exit_code, session_id, cwd, tier, dream_type, source_chunk_ids,
        trajectory_id, chunk_index, chunk_count, artifacts,
        similarity, keyword_rank,
        (${vectorWeight}::float * similarity + ${keywordWeight}::float * keyword_rank)
          * CASE
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
      chunk: {
        id: r.id,
        embedding: [],
        content: r.content,
        metadata: {
          repo: r.repo,
          branch: r.branch,
          timestamp: r.timestamp,
          filePaths: r.file_paths ?? [],
          exitCode: r.exit_code,
          sessionId: r.session_id,
          cwd: r.cwd,
          tier: r.tier,
          dreamType: r.dream_type ?? undefined,
          sourceChunkIds: r.source_chunk_ids ?? undefined,
          trajectoryId: r.trajectory_id ?? undefined,
          chunkIndex: r.chunk_index ?? undefined,
          chunkCount: r.chunk_count ?? undefined,
          artifacts: r.artifacts ?? undefined,
        },
      },
    }));
  }

  async getTrajectory(trajectoryId: string): Promise<Chunk[]> {
    const rows = await this.sql<
      Array<{
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
      }>
    >`
      SELECT
        id, content, repo, branch, timestamp, file_paths,
        exit_code, session_id, cwd, tier, dream_type, source_chunk_ids,
        trajectory_id, chunk_index, chunk_count, artifacts
      FROM chunks
      WHERE trajectory_id = ${trajectoryId}
      ORDER BY chunk_index ASC NULLS LAST
    `;

    return rows.map((r) => ({
      id: r.id,
      embedding: [],
      content: r.content,
      metadata: {
        repo: r.repo,
        branch: r.branch,
        timestamp: r.timestamp,
        filePaths: r.file_paths ?? [],
        exitCode: r.exit_code,
        sessionId: r.session_id,
        cwd: r.cwd,
        tier: r.tier,
        dreamType: r.dream_type ?? undefined,
        sourceChunkIds: r.source_chunk_ids ?? undefined,
        trajectoryId: r.trajectory_id ?? undefined,
        chunkIndex: r.chunk_index ?? undefined,
        chunkCount: r.chunk_count ?? undefined,
        artifacts: r.artifacts ?? undefined,
      },
    }));
  }

  async count(): Promise<number> {
    const [row] = await this.sql<Array<{ count: string }>>`SELECT COUNT(*)::text AS count FROM chunks`;
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
  // the dream layer (tier='raw') and the wiki layer (tier='dream').
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
    const rows = await this.sql<
      Array<{ id: string; content: string; timestamp: Date; dream_type: string | null; artifacts: Artifact[] | null }>
    >`
      SELECT id, content, timestamp, dream_type, artifacts
      FROM chunks
      WHERE tier = ${tier} AND owner = ${owner} AND session_id = ${sessionId}
        AND COALESCE(repo, '') = ${repo}
      ORDER BY timestamp ASC NULLS LAST, chunk_index ASC NULLS LAST
    `;
    return rows.map((r) => ({
      id: r.id,
      embedding: [],
      content: r.content,
      metadata: {
        repo,
        branch: '',
        timestamp: r.timestamp,
        filePaths: [],
        exitCode: null,
        sessionId,
        cwd: '',
        tier,
        dreamType: r.dream_type ?? undefined,
        artifacts: r.artifacts ?? undefined,
      },
    }));
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

  // tier='dream' wrapper kept for the dream layer's call site.
  async deleteDreamChunks(ids: string[], owner: string): Promise<number> {
    return this.deleteChunksByIds(ids, owner, 'dream');
  }

  // --- WikiLedger ------------------------------------------------------------

  async listDreamUnitsAsUnits(owner: string, opts: { repo?: string; since?: Date } = {}): Promise<SynthesisUnit[]> {
    return this.aggregateUnits('dream', owner, opts);
  }

  async listWikiChunkIds(owner: string): Promise<Array<{ id: string; trajectoryId: string | null }>> {
    const rows = await this.sql<Array<{ id: string; trajectory_id: string | null }>>`
      SELECT id, trajectory_id FROM chunks WHERE tier = 'wiki' AND owner = ${owner}
    `;
    return rows.map((r) => ({ id: r.id, trajectoryId: r.trajectory_id }));
  }

  // Subset of the given ids that exist as chunks of the given tier — used by
  // wiki lint's broken-provenance check (sources must be real dream chunks).
  async existingChunkIds(ids: string[], tier: string): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.sql<Array<{ id: string }>>`
      SELECT id FROM chunks WHERE tier = ${tier} AND id = ANY(${ids as string[]})
    `;
    return new Set(rows.map((r) => r.id));
  }

  // --- WikiEvidenceStore -----------------------------------------------------

  // Units where the wiki ledger hasn't absorbed the current dream knowledge and
  // the dream stamp is older than staleHours. The 48h prefilter runs in SQL; the
  // fingerprint decision is delegated to the same pure rule wiki lint tests, so
  // "up to date" here means EXACTLY what ingestWiki's short-circuit means.
  //   NOTE: dream_units.fingerprint is sha256(sorted RAW ids) and
  //   wiki_units.fingerprint is sha256(sorted DREAM ids) — different id domains,
  //   never equal even when in sync. The comparable dream signal is
  //   sha256(sorted dream_units.dream_chunk_ids), which is what ingest hashes.
  async pendingWikiUnits(owner: string, staleHours = 48): Promise<PendingUnit[]> {
    const cutoff = new Date(Date.now() - staleHours * 3_600_000);
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
    return pendingUnitsFrom(
      rows.map((r) => ({
        sessionId: r.session_id,
        repo: r.repo,
        dreamChunkIds: r.dream_chunk_ids,
        wikiFingerprint: r.wiki_fingerprint,
        synthesizedAt: r.synthesized_at,
      })),
      new Date(),
      staleHours
    );
  }

  // Distinct sessions + first/last timestamp over a page's dream source chunks.
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
      WHERE w.tier = 'wiki' AND w.owner = ${owner}
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
    const rows = await this.sql<
      Array<{ id: string; content: string; timestamp: Date; session_id: string; dream_type: string | null; trajectory_id: string | null; artifacts: Artifact[] | null }>
    >`
      SELECT id, content, timestamp, session_id, dream_type, trajectory_id, artifacts
      FROM chunks
      WHERE tier = 'dream' AND owner = ${owner} AND repo = ${repo}
        AND timestamp >= ${since} AND dream_type = ANY(${types})
      ORDER BY timestamp DESC, id ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      embedding: [],
      content: r.content,
      metadata: {
        repo,
        branch: '',
        timestamp: r.timestamp,
        filePaths: [],
        exitCode: null,
        sessionId: r.session_id,
        cwd: '',
        tier: 'dream' as const,
        owner,
        dreamType: r.dream_type ?? undefined,
        trajectoryId: r.trajectory_id ?? undefined,
        artifacts: r.artifacts ?? undefined,
      },
    }));
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
      ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('english', ${queryText}), 32) DESC, trajectory_id ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({ trajectoryId: r.trajectory_id, rank: Number(r.rank), content: r.content }));
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
