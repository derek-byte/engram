import { describe, expect, test } from 'bun:test';
import type { Chunk } from '../types/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { CHUNKER_VERSION } from '../types/index.ts';
import { LOCAL_DIM } from '../config/defaults.ts';
import { Embedder } from '../ingest/embed.ts';
import { FakeProvider } from '../ingest/testkit.ts';
import { buildContext } from './compose.ts';

const LIVE = process.env.ENGRAM_TEST_LIVE === '1';
const DB_URL = process.env.ENGRAM_DATABASE_URL ?? 'postgresql://engram:engram@localhost:5432/engram';
const OWNER = 'test:ctx';
const REPO = 'ctx-repo';
const FAKE_MODEL = 'test-fake-384';
const NOW = new Date('2026-07-04T00:00:00Z');

function dream(id: string, type: string, content: string, ageDays: number): Chunk {
  return {
    id,
    embedding: [],
    content,
    metadata: {
      repo: REPO,
      branch: '',
      timestamp: new Date(NOW.getTime() - ageDays * 86_400_000),
      filePaths: [],
      exitCode: null,
      sessionId: 'cs1',
      cwd: '',
      tier: 'dream',
      owner: OWNER,
      dreamType: type,
      trajectoryId: `dream:cs1`,
      chunkIndex: 0,
      chunkCount: 1,
    },
  };
}

function wiki(slug: string, content: string, sources: string[]): Chunk {
  return {
    id: `w-${slug}`,
    embedding: [],
    content,
    metadata: {
      repo: '',
      branch: '',
      timestamp: NOW,
      filePaths: [],
      exitCode: null,
      sessionId: '',
      cwd: '',
      tier: 'wiki',
      owner: OWNER,
      trajectoryId: `wiki:${slug}`,
      sourceChunkIds: sources,
      chunkIndex: 0,
      chunkCount: 1,
    },
  };
}

describe('live context compose (provenance + recency + mention arms)', () => {
  test.skipIf(!LIVE)('ranks provenance before mention, excludes stale/fix dreams', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    const embedder = new Embedder(new FakeProvider({ dim: LOCAL_DIM, model: FAKE_MODEL }), backend);
    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');

      const chunks: Chunk[] = [
        // Recent, valid → included as memories.
        dream('cd1', 'decision', 'We decided to use pgvector for ctx-repo storage.', 2),
        dream('cd2', 'gotcha', 'ctx-repo drops long trajectories silently.', 5),
        // Excluded from memories: older than 30d, and a non-durable type.
        dream('cd3', 'decision', 'An ancient ctx-repo decision.', 90),
        dream('cd4', 'fix', 'A ctx-repo fix that should not surface.', 1),
        // Provenance wiki page: sources trace to ctx-repo dream chunks.
        wiki('ctx-page', 'Wiki page compiled from ctx-repo sessions.', ['cd1', 'cd2', 'cd3', 'cd4']),
        // Mention-only wiki page: no provenance, but names the repo verbatim.
        wiki('mention-page', 'An unrelated page that happens to mention ctx-repo in passing.', []),
      ];
      const vecs = await embedder.embed(chunks.map((c) => c.content));
      chunks.forEach((c, i) => (c.embedding = vecs[i]!));
      await backend.upsert(chunks);

      const r = await buildContext(
        { repo: REPO, owner: OWNER, budgetTokens: 2000, now: NOW },
        { backend, store: null }
      );

      // Provenance page ranks before the mention page.
      const slugs = r.pages.map((p) => p.slug);
      expect(slugs).toContain('ctx-page');
      expect(slugs).toContain('mention-page');
      expect(slugs.indexOf('ctx-page')).toBeLessThan(slugs.indexOf('mention-page'));
      expect(r.pages.find((p) => p.slug === 'ctx-page')!.source).toBe('provenance');
      expect(r.pages.find((p) => p.slug === 'mention-page')!.source).toBe('mention');

      // Memories: only the recent decision + gotcha; stale + fix excluded.
      const texts = r.memories.map((m) => m.text).join('\n');
      expect(r.memories.length).toBe(2);
      expect(texts).toContain('pgvector for ctx-repo');
      expect(texts).toContain('drops long trajectories');
      expect(texts).not.toContain('ancient');
      expect(texts).not.toContain('fix that should not surface');
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await backend.close();
    }
  });
});
