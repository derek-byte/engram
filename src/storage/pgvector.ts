import postgres from 'postgres';
import type { Chunk, RawEvent, SearchFilters, SearchResult } from '../types/index.ts';
import type { VectorBackend } from './backend.ts';

const DEFAULT_OWNER = 'derek';

export class PgVectorBackend implements VectorBackend {
  private sql: ReturnType<typeof postgres>;
  private embeddingDim: number;
  private embeddingModel: string;
  private chunkerVersion: string;

  constructor(databaseUrl: string, embeddingDim: number, embeddingModel: string, chunkerVersion: string) {
    // SSL is derived from the URL (e.g. ?sslmode=require for Neon).
    // Local Postgres URLs without sslmode connect without TLS.
    this.sql = postgres(databaseUrl, { prepare: false, onnotice: () => {} });
    this.embeddingDim = embeddingDim;
    this.embeddingModel = embeddingModel;
    this.chunkerVersion = chunkerVersion;
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
        trajectory_id TEXT,
        chunk_index INTEGER,
        chunk_count INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT '${DEFAULT_OWNER}';`);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunker_version TEXT;`);
    await this.sql.unsafe(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT;`);

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
        trajectory_id: c.metadata.trajectoryId ?? null,
        chunk_index: c.metadata.chunkIndex ?? null,
        chunk_count: c.metadata.chunkCount ?? null,
      };
    });

    for (const r of rows) {
      await this.sql`
        INSERT INTO chunks (
          id, embedding, content, model_id, embedding_dim,
          owner, chunker_version, embedding_model,
          repo, branch, timestamp, file_paths, exit_code,
          session_id, cwd, tier, trajectory_id, chunk_index, chunk_count
        ) VALUES (
          ${r.id}, ${r.embedding}::vector, ${r.content}, ${r.model_id}, ${r.embedding_dim},
          ${r.owner}, ${r.chunker_version}, ${r.embedding_model},
          ${r.repo}, ${r.branch}, ${r.timestamp}, ${r.file_paths as string[]}, ${r.exit_code},
          ${r.session_id}, ${r.cwd}, ${r.tier}, ${r.trajectory_id}, ${r.chunk_index}, ${r.chunk_count}
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

  async search(queryEmbedding: number[], filters: SearchFilters): Promise<SearchResult[]> {
    const vec = formatVector(queryEmbedding);
    const limit = filters.limit ?? 5;
    const tierFilter = filters.tier && filters.tier !== 'both' ? filters.tier : null;

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
      tier: 'raw' | 'dream';
      trajectory_id: string | null;
      chunk_index: number | null;
      chunk_count: number | null;
      distance: number;
    };

    const query = (sql: postgres.ISql) => sql<Row[]>`
      SELECT
        id, content, repo, branch, timestamp, file_paths,
        exit_code, session_id, cwd, tier,
        trajectory_id, chunk_index, chunk_count,
        embedding <=> ${vec}::vector AS distance
      FROM chunks
      WHERE
        (${filters.repo ?? null}::text IS NULL OR repo = ${filters.repo ?? null})
        AND (${filters.branch ?? null}::text IS NULL OR branch = ${filters.branch ?? null})
        AND (${filters.since ?? null}::timestamptz IS NULL OR timestamp >= ${filters.since ?? null})
        AND (${tierFilter}::text IS NULL OR tier = ${tierFilter})
        AND (${filters.exitCode ?? null}::int IS NULL OR exit_code = ${filters.exitCode ?? null})
        AND (${filters.owner ?? null}::text IS NULL OR owner = ${filters.owner ?? null})
      ORDER BY distance ASC
      LIMIT ${limit}
    `;

    // Exhaustive mode forces a seq scan (exact cosine) so a selective owner
    // filter can't be starved by the HNSW candidate set. SET LOCAL is scoped to
    // the transaction, so production searches are unaffected.
    const rows = filters.exhaustive
      ? await this.sql.begin(async (tx) => {
          await tx`SET LOCAL enable_indexscan = off`;
          await tx`SET LOCAL enable_bitmapscan = off`;
          return query(tx);
        })
      : await query(this.sql);

    return rows.map((r) => ({
      similarity: 1 - r.distance,
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
          trajectoryId: r.trajectory_id ?? undefined,
          chunkIndex: r.chunk_index ?? undefined,
          chunkCount: r.chunk_count ?? undefined,
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
        tier: 'raw' | 'dream';
        trajectory_id: string | null;
        chunk_index: number | null;
        chunk_count: number | null;
      }>
    >`
      SELECT
        id, content, repo, branch, timestamp, file_paths,
        exit_code, session_id, cwd, tier,
        trajectory_id, chunk_index, chunk_count
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
        trajectoryId: r.trajectory_id ?? undefined,
        chunkIndex: r.chunk_index ?? undefined,
        chunkCount: r.chunk_count ?? undefined,
      },
    }));
  }

  async count(): Promise<number> {
    const [row] = await this.sql<Array<{ count: string }>>`SELECT COUNT(*)::text AS count FROM chunks`;
    return Number(row.count);
  }

  // Retract every chunk + raw event for an owner, atomically. Exact match: the
  // store-of-record and its index both go, so an owner's data leaves no trace.
  async deleteByOwner(owner: string): Promise<{ chunks: number; rawEvents: number }> {
    return this.sql.begin(async (tx) => {
      const c = await tx`DELETE FROM chunks WHERE owner = ${owner}`;
      const r = await tx`DELETE FROM raw_events WHERE owner = ${owner}`;
      return { chunks: c.count, rawEvents: r.count };
    });
  }

  // Same, for every owner sharing a prefix (e.g. 'bench:' → 'bench:%').
  async deleteByOwnerPrefix(prefix: string): Promise<{ chunks: number; rawEvents: number }> {
    const like = prefix + '%';
    return this.sql.begin(async (tx) => {
      const c = await tx`DELETE FROM chunks WHERE owner LIKE ${like}`;
      const r = await tx`DELETE FROM raw_events WHERE owner LIKE ${like}`;
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
