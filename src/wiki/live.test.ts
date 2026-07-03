import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chunk } from '../types/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { LOCAL_DIM } from '../ingest/embed.ts';
import { Embedder } from '../ingest/embed.ts';
import { FakeProvider, FakeWikiLLM, testConfig } from '../ingest/testkit.ts';
import { WikiStore } from './store.ts';
import { ingestWiki } from './ingest.ts';
import type { WikiPageOp } from './llm.ts';

const LIVE = process.env.ENGRAM_TEST_LIVE === '1';
const DB_URL = process.env.ENGRAM_DATABASE_URL ?? 'postgresql://engram:engram@localhost:5432/engram';
const SRC = 'test:wiki-dream';
const WIKI = 'test:wiki';
const FAKE_MODEL = 'test-fake-384';

function dreamChunk(id: string, sessionId: string, kind: string, content: string): Chunk {
  return {
    id,
    embedding: [],
    content,
    metadata: {
      repo: 'engram',
      branch: '',
      timestamp: new Date(1_700_000_000_000),
      filePaths: [],
      exitCode: null,
      sessionId,
      cwd: '',
      tier: 'dream',
      owner: SRC,
      dreamType: kind,
      trajectoryId: `dream:${sessionId}`,
      chunkIndex: 0,
      chunkCount: 1,
    },
  };
}

const script = (): { pages: WikiPageOp[] } => ({
  pages: [
    { slug: 'pgvector', action: 'create', kind: 'tool', title: 'pgvector', summary: 'the vector store', aliases: [], body: 'pgvector backs the [[fingerprint-skip]] index in engram.', sources: ['wd1'] },
    { slug: 'fingerprint-skip', action: 'create', kind: 'decision', title: 'Fingerprint short-circuit', summary: 'skip unchanged units', aliases: [], body: 'We decided the fingerprint short-circuit relies on [[pgvector]].', sources: ['wd2'] },
  ],
});

describe('live wiki ingest → search → skip → retract', () => {
  test.skipIf(!LIVE)('compiles pages under a test owner, embeds them, re-run skips, cleans up', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    const raw = postgres(DB_URL, { prepare: false, onnotice: () => {} });
    const embedder = new Embedder(new FakeProvider({ dim: LOCAL_DIM, model: FAKE_MODEL }), backend);
    const dir = join(tmpdir(), `engram-wiki-live-${crypto.randomUUID()}`);
    const store = new WikiStore(dir);
    const llm = new FakeWikiLLM(script);
    const config = testConfig({ wikiDir: dir, wikiModel: 'fake-wiki' });

    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');

      const seeds = [
        dreamChunk('wd1', 'wsess-1', 'decision', 'we chose pgvector for the vector store'),
        dreamChunk('wd2', 'wsess-1', 'gotcha', 'the fingerprint short-circuit skips unchanged units'),
      ];
      const seedVecs = await embedder.embed(seeds.map((c) => c.content));
      seeds.forEach((c, i) => (c.embedding = seedVecs[i]!));
      await backend.upsert(seeds);

      const res = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, { backend, store, embedder, llm, config });
      expect(res.pagesCreated).toBe(2);
      expect(res.unitsCompiled).toBe(1);

      // Embedded into pg under tier='wiki'; searchable.
      const qv = await embedder.embedOne('pgvector fingerprint index');
      const hits = await backend.search(qv, 'pgvector fingerprint index', { owner: WIKI, tier: 'wiki', exhaustive: true, limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.chunk.metadata.tier).toBe('wiki');

      // Trajectory drill-down resolves the full page.
      const traj = await backend.getTrajectory('wiki:pgvector');
      expect(traj.length).toBeGreaterThan(0);

      // Re-run: fingerprints unchanged → skip, no LLM calls.
      const before = llm.callCount;
      const rerun = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, { backend, store, embedder, llm, config });
      expect(rerun.unitsSkipped).toBe(1);
      expect(llm.callCount).toBe(before);

      // Cleanup purges every test: row across chunks + wiki_units.
      await backend.deleteByOwnerPrefix('test:');
      const [{ chunks }] = await raw<Array<{ chunks: string }>>`SELECT COUNT(*)::text AS chunks FROM chunks WHERE owner LIKE 'test:%'`;
      const [{ units }] = await raw<Array<{ units: string }>>`SELECT COUNT(*)::text AS units FROM wiki_units WHERE owner LIKE 'test:%'`;
      expect(Number(chunks)).toBe(0);
      expect(Number(units)).toBe(0);
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await raw.end();
      await backend.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
