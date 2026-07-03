import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { LOCAL_DIM } from '../ingest/embed.ts';
import { Embedder } from '../ingest/embed.ts';
import { injectDocuments, type InjectDoc } from '../ingest/inject.ts';
import { FakeDreamLLM, FakeProvider, testConfig } from '../ingest/testkit.ts';
import { synthesizeDreams } from './synthesize.ts';

const LIVE = process.env.ENGRAM_TEST_LIVE === '1';
const DB_URL = process.env.ENGRAM_DATABASE_URL ?? 'postgresql://engram:engram@localhost:5432/engram';
const SRC = 'test:dream-src';
const DREAM = 'test:dream';
const FAKE_MODEL = 'test-fake-384';

describe('live dream synthesize → search → retract', () => {
  test.skipIf(!LIVE)('synthesizes under a test owner, finds it, re-run skips, retracts cleanly', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    const raw = postgres(DB_URL, { prepare: false, onnotice: () => {} });
    const provider = new FakeProvider({ dim: LOCAL_DIM, model: FAKE_MODEL });
    const embedder = new Embedder(provider, backend);
    const llm = new FakeDreamLLM(() => [
      { type: 'decision', text: 'chose pgvector HNSW over a flat index for the dream layer live test' },
    ]);
    const config = testConfig({ dreamModel: 'fake-dream-model' });

    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');

      // Seed raw source chunks under a test owner (two docs = one session each).
      const docs: InjectDoc[] = [
        { id: 'live-sess-1', content: 'we decided to use pgvector for the dream layer', owner: SRC, source: 'live-test' },
        { id: 'live-sess-2', content: 'fixed the fingerprint short-circuit bug', owner: SRC, source: 'live-test' },
      ];
      await injectDocuments(docs, { backend, embedder, config });

      const res = await synthesizeDreams(
        { sourceOwner: SRC, dreamOwner: DREAM, limit: 20, dryRun: false },
        { backend, embedder, llm, config }
      );
      expect(res.synthesized).toBe(2);
      expect(res.dreamChunks).toBe(2);

      // Dream chunks are searchable via the tier=dream filter.
      const queryVec = await embedder.embedOne('pgvector HNSW dream layer');
      const hits = await backend.search(queryVec, 'pgvector HNSW dream layer', {
        owner: DREAM,
        tier: 'dream',
        exhaustive: true,
        limit: 5,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.chunk.metadata.tier).toBe('dream');
      expect(hits[0]!.chunk.metadata.dreamType).toBe('decision');

      // Re-run: fingerprints unchanged → all skipped, no new LLM calls.
      const callsBefore = llm.callCount;
      const rerun = await synthesizeDreams(
        { sourceOwner: SRC, dreamOwner: DREAM, limit: 20, dryRun: false },
        { backend, embedder, llm, config }
      );
      expect(rerun.synthesized).toBe(0);
      expect(rerun.skipped).toBe(2);
      expect(llm.callCount).toBe(callsBefore);

      // Cleanup purges every test:-owned row across all three tables.
      await backend.deleteByOwnerPrefix('test:');
      const [{ chunks }] = await raw<Array<{ chunks: string }>>`
        SELECT COUNT(*)::text AS chunks FROM chunks WHERE owner LIKE 'test:%'`;
      const [{ events }] = await raw<Array<{ events: string }>>`
        SELECT COUNT(*)::text AS events FROM raw_events WHERE owner LIKE 'test:%'`;
      const [{ units }] = await raw<Array<{ units: string }>>`
        SELECT COUNT(*)::text AS units FROM dream_units WHERE owner LIKE 'test:%'`;
      expect(Number(chunks)).toBe(0);
      expect(Number(events)).toBe(0);
      expect(Number(units)).toBe(0);
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await raw.end();
      await backend.close();
    }
  });
});
