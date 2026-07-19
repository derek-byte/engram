import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import type { Chunk, EmbeddedChunk } from '../types/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { Embedder, type EmbeddingProvider, type ProviderEmbedding } from '../ingest/embed.ts';
import { runReembedSweep } from './backfill.ts';
import { CHUNKER_VERSION } from '../types/index.ts';

const LIVE = process.env.ENGRAM_TEST_LIVE === '1';
const DB_URL = process.env.ENGRAM_DATABASE_URL ?? 'postgresql://engram:engram@localhost:5432/engram';

const START_DIM = 384;
const TARGET_DIM = 8;
const START_MODEL = 'fake-start-384';
const TARGET_MODEL = 'fake-target-8';
const OWNER = 'derek';

// A fixed-dim provider whose vectors are a pure function of the text — no model
// download, deterministic. Used at both 384 (seed) and 8 (re-embed target).
class FixedDimProvider implements EmbeddingProvider {
  constructor(
    readonly model: string,
    readonly dim: number
  ) {}
  async embed(texts: string[]): Promise<ProviderEmbedding> {
    return {
      vectors: texts.map((t) => {
        const out = new Array<number>(this.dim).fill(0);
        for (let i = 0; i < t.length; i++) out[i % this.dim]! += t.charCodeAt(i);
        return out;
      }),
      model: this.model,
    };
  }
}

function chunk(id: string, tier: 'raw' | 'dream' | 'wiki', content: string, embedding: number[]): EmbeddedChunk {
  return {
    id,
    embedding,
    content,
    metadata: {
      repo: 'reembed-repo',
      branch: 'main',
      timestamp: new Date('2026-06-01T00:00:00Z'),
      filePaths: [`src/${id}.ts`],
      exitCode: null,
      sessionId: `sess-${tier}`,
      cwd: '/tmp/work',
      tier,
      owner: OWNER,
      embeddingModel: START_MODEL,
      chunkIndex: 0,
      chunkCount: 1,
      trajectoryId: `traj-${id}`,
    },
  };
}

describe('live re-embed migration (temporary database)', () => {
  test.skipIf(!LIVE)(
    'migrates chunks.embedding 384 -> 8, re-embeds all tiers in place, preserves content, second run no-ops',
    async () => {
      const dbName = `engram_test_reembed_${process.pid}`;
      const admin = postgres(DB_URL, { prepare: false, onnotice: () => {} });
      // Isolated DB URL: swap only the database name on the live connection string.
      const tmpUrl = (() => {
        const u = new URL(DB_URL);
        u.pathname = `/${dbName}`;
        return u.toString();
      })();

      let tmpUrlReady = false;
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.unsafe(`CREATE DATABASE ${dbName}`);
        tmpUrlReady = true;

        // --- Seed the temp DB at 384 dims across raw/dream/wiki ----------------
        const seedProvider = new FixedDimProvider(START_MODEL, START_DIM);
        const seedBackend = new PgVectorBackend(tmpUrl, START_DIM, START_MODEL, CHUNKER_VERSION);
        const verify = postgres(tmpUrl, { prepare: false, onnotice: () => {} });
        try {
          await seedBackend.initialize();
          const seedEmbedder = new Embedder(seedProvider, seedBackend);

          const specs: Array<{ id: string; tier: 'raw' | 'dream' | 'wiki'; content: string }> = [
            { id: 'raw-a', tier: 'raw', content: 'raw tier content alpha' },
            { id: 'raw-b', tier: 'raw', content: 'raw tier content beta' },
            { id: 'dream-a', tier: 'dream', content: 'dream synthesis only lives in chunks' },
            { id: 'wiki-a', tier: 'wiki', content: 'wiki page body compiled from dreams' },
          ];
          const vecs = await seedEmbedder.embed(specs.map((s) => s.content));
          await seedBackend.upsert(specs.map((s, i) => chunk(s.id, s.tier, s.content, vecs[i]!)));

          // Snapshot content + metadata to prove they survive byte-for-byte.
          type Snap = { id: string; content: string; tier: string; owner: string; repo: string; session_id: string; chunk_index: number };
          const before = await verify<Snap[]>`
            SELECT id, content, tier, owner, repo, session_id, chunk_index FROM chunks ORDER BY id
          `;
          expect(before.length).toBe(4);

          // --- Drive the re-embed path targeting dim 8 --------------------------
          const targetProvider = new FixedDimProvider(TARGET_MODEL, TARGET_DIM);
          const targetBackend = new PgVectorBackend(tmpUrl, TARGET_DIM, TARGET_MODEL, CHUNKER_VERSION);
          const targetEmbedder = new Embedder(targetProvider, targetBackend);
          try {
            expect(await targetBackend.reembedColumnDim()).toBe(START_DIM);
            expect(await targetBackend.reembedRowCount()).toBe(4);

            await targetBackend.migrateEmbeddingColumn(TARGET_DIM);

            const sweep = await runReembedSweep(
              {
                fetchBatch: (limit) => targetBackend.reembedFetchBatch(TARGET_MODEL, limit),
                embed: async (contents, labels) => {
                  const r = await targetEmbedder.embedWithStats(contents, labels);
                  return { embeddings: r.embeddings, model: r.model, cacheHits: r.cacheHits, cacheMisses: r.cacheMisses };
                },
                writeBatch: (writes) => targetBackend.reembedWriteBatch(writes),
              },
              { batchSize: 2, total: 4 }
            );
            expect(sweep.reembedded).toBe(4);

            // Finalize: consistent now -> full DDL recreates the HNSW index.
            await targetBackend.initialize();

            // Content + metadata byte-identical.
            const after = await verify<Snap[]>`
              SELECT id, content, tier, owner, repo, session_id, chunk_index FROM chunks ORDER BY id
            `;
            expect(after).toEqual(before);

            // Every embedding is now 8-dim under the target model, none NULL.
            const dims = await verify<Array<{ id: string; d: number; m: string }>>`
              SELECT id, vector_dims(embedding) AS d, embedding_model AS m FROM chunks ORDER BY id
            `;
            expect(dims.length).toBe(4);
            for (const row of dims) {
              expect(row.d).toBe(TARGET_DIM);
              expect(row.m).toBe(TARGET_MODEL);
            }
            expect(await targetBackend.reembedNullCount()).toBe(0);

            // Column typmod is 8.
            const [attr] = await verify<Array<{ atttypmod: number }>>`
              SELECT atttypmod FROM pg_attribute
              WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'
            `;
            expect(attr?.atttypmod).toBe(TARGET_DIM);

            // HNSW index was recreated.
            const [idx] = await verify<Array<{ n: string }>>`
              SELECT count(*)::text AS n FROM pg_class WHERE relname = 'chunks_embedding_idx'
            `;
            expect(Number(idx?.n ?? 0)).toBe(1);

            // Second run is a clean no-op: dim already matches, every row on model.
            expect(await targetBackend.reembedColumnDim()).toBe(TARGET_DIM);
            const rerun = await runReembedSweep(
              {
                fetchBatch: (limit) => targetBackend.reembedFetchBatch(TARGET_MODEL, limit),
                embed: async (contents, labels) => {
                  const r = await targetEmbedder.embedWithStats(contents, labels);
                  return { embeddings: r.embeddings, model: r.model, cacheHits: r.cacheHits, cacheMisses: r.cacheMisses };
                },
                writeBatch: (writes) => targetBackend.reembedWriteBatch(writes),
              },
              { batchSize: 2, total: 4 }
            );
            expect(rerun.reembedded).toBe(0);
            expect(rerun.batches).toBe(0);
          } finally {
            await targetBackend.close();
          }
        } finally {
          await verify.end();
          await seedBackend.close();
        }
      } finally {
        // Drop the temp DB — never touch the live `engram` database's tables.
        if (tmpUrlReady) {
          await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
        }
        await admin.end();
      }
    }
  );
});
