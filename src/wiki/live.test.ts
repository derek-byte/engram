import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chunk, EmbeddedChunk } from '../types/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { CHUNKER_VERSION } from '../types/index.ts';
import { LOCAL_DIM } from '../config/defaults.ts';
import { Embedder } from '../ingest/embed.ts';
import { FakeProvider, FakeWikiLLM, testConfig } from '../ingest/testkit.ts';
import { WikiStore } from './store.ts';
import { ingestWiki } from './ingest.ts';
import { OpenAIWikiLLM, type WikiPageOp } from './llm.ts';

const LIVE = process.env.ENGRAM_TEST_LIVE === '1';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const DB_URL = process.env.ENGRAM_DATABASE_URL ?? 'postgresql://engram:engram@localhost:5432/engram';
const SRC = 'test:wiki-dream';
const WIKI = 'test:wiki';
const FAKE_MODEL = 'test-fake-384';

function dreamChunk(id: string, sessionId: string, kind: string, content: string): EmbeddedChunk {
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

// Real-LLM reconciliation probe: a later session reverses an earlier decision;
// chronological compile must land the revised position with an evolution line,
// not both as co-equal facts. Flaky by nature (LLM output) → tolerant asserts;
// runs only under ENGRAM_TEST_LIVE=1 with a real OPENAI_API_KEY (costs money).
describe('live wiki reconciliation (real LLM)', () => {
  test.skipIf(!LIVE || !OPENAI_KEY)('a later session revises an earlier decision, not co-equal', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    const embedder = new Embedder(new FakeProvider({ dim: LOCAL_DIM, model: FAKE_MODEL }), backend);
    const dir = join(tmpdir(), `engram-wiki-reconcile-${crypto.randomUUID()}`);
    const store = new WikiStore(dir);
    const llm = new OpenAIWikiLLM(OPENAI_KEY!, process.env.ENGRAM_WIKI_MODEL ?? 'gpt-4o-mini');
    const config = testConfig({ wikiDir: dir, wikiModel: 'gpt-4o-mini' });

    // Two sessions, overlapping entity (the DB decision), t1 older than t2.
    const mk = (id: string, sess: string, kind: string, content: string, ts: number): EmbeddedChunk => ({
      ...dreamChunk(id, sess, kind, content),
      metadata: { ...dreamChunk(id, sess, kind, content).metadata, timestamp: new Date(ts) },
    });

    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');
      const seeds = [
        mk('rc1', 'r-early', 'decision', 'We decided engram will use Neon (hosted Postgres) as its database.', 1_714_500_000_000),
        mk('rc2', 'r-late', 'decision', 'Revised the earlier database decision: engram now runs local Docker Postgres instead of Neon.', 1_717_500_000_000),
      ];
      const vecs = await embedder.embed(seeds.map((c) => c.content));
      seeds.forEach((c, i) => (c.embedding = vecs[i]!));
      await backend.upsert(seeds);

      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, { backend, store, embedder, llm, config });

      const bodies = store.listPages().map((p) => p.body.toLowerCase());
      const all = bodies.join('\n');
      expect(all).toContain('docker'); // the current (revised) position is present
      // Reconciled, not co-equal: an evolution line records the change.
      expect(/originally|revised|superseded|previously/.test(all)).toBe(true);
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await backend.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
