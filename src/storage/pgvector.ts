import postgres from 'postgres';
import type { Chunk, SearchFilters, SearchResult } from '../types/index.ts';
import type { VectorBackend } from './backend.ts';

export class PgVectorBackend implements VectorBackend {
  private sql: ReturnType<typeof postgres>;
  private embeddingDim: number;

  constructor(databaseUrl: string, embeddingDim: number) {
    this.sql = postgres(databaseUrl, { ssl: 'require', prepare: false });
    this.embeddingDim = embeddingDim;
  }

  async initialize(): Promise<void> {
    await this.sql`CREATE EXTENSION IF NOT EXISTS vector`;

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        embedding vector(${this.embeddingDim}),
        content TEXT NOT NULL,
        model_id TEXT NOT NULL,
        embedding_dim INTEGER NOT NULL,
        repo TEXT,
        branch TEXT,
        timestamp TIMESTAMPTZ,
        file_paths TEXT[],
        exit_code INTEGER,
        session_id TEXT,
        cwd TEXT,
        tier TEXT DEFAULT 'raw',
        dream_type TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await this.sql.unsafe(`
      CREATE INDEX IF NOT EXISTS chunks_embedding_idx
      ON chunks USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    `);

    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_repo_idx ON chunks (repo);`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_branch_idx ON chunks (branch);`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_tier_idx ON chunks (tier);`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS chunks_timestamp_idx ON chunks (timestamp);`);
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const rows = chunks.map((c) => ({
      id: c.id,
      embedding: formatVector(c.embedding),
      content: c.content,
      model_id: 'text-embedding-3-small',
      embedding_dim: this.embeddingDim,
      repo: c.metadata.repo,
      branch: c.metadata.branch,
      timestamp: c.metadata.timestamp,
      file_paths: c.metadata.filePaths,
      exit_code: c.metadata.exitCode,
      session_id: c.metadata.sessionId,
      cwd: c.metadata.cwd,
      tier: c.metadata.tier,
    }));

    for (const r of rows) {
      await this.sql`
        INSERT INTO chunks (
          id, embedding, content, model_id, embedding_dim,
          repo, branch, timestamp, file_paths, exit_code,
          session_id, cwd, tier
        ) VALUES (
          ${r.id}, ${r.embedding}::vector, ${r.content}, ${r.model_id}, ${r.embedding_dim},
          ${r.repo}, ${r.branch}, ${r.timestamp}, ${r.file_paths as string[]}, ${r.exit_code},
          ${r.session_id}, ${r.cwd}, ${r.tier}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  async search(queryEmbedding: number[], filters: SearchFilters): Promise<SearchResult[]> {
    const vec = formatVector(queryEmbedding);
    const limit = filters.limit ?? 5;
    const tierFilter = filters.tier && filters.tier !== 'both' ? filters.tier : null;

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
        distance: number;
      }>
    >`
      SELECT
        id, content, repo, branch, timestamp, file_paths,
        exit_code, session_id, cwd, tier,
        embedding <=> ${vec}::vector AS distance
      FROM chunks
      WHERE
        (${filters.repo ?? null}::text IS NULL OR repo = ${filters.repo ?? null})
        AND (${filters.branch ?? null}::text IS NULL OR branch = ${filters.branch ?? null})
        AND (${filters.since ?? null}::timestamptz IS NULL OR timestamp >= ${filters.since ?? null})
        AND (${tierFilter}::text IS NULL OR tier = ${tierFilter})
        AND (${filters.exitCode ?? null}::int IS NULL OR exit_code = ${filters.exitCode ?? null})
      ORDER BY distance ASC
      LIMIT ${limit}
    `;

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
        },
      },
    }));
  }

  async count(): Promise<number> {
    const [row] = await this.sql<Array<{ count: string }>>`SELECT COUNT(*)::text AS count FROM chunks`;
    return Number(row.count);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

function formatVector(v: number[]): string {
  return '[' + v.join(',') + ']';
}
