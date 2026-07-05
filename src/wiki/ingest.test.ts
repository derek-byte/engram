import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact, Chunk } from '../types/index.ts';
import { FakeBackend, FakeProvider, FakeWikiLLM, testConfig } from '../ingest/testkit.ts';
import { Embedder } from '../ingest/embed.ts';
import { WikiStore, pageFingerprint } from './store.ts';
import { ingestWiki, reindexWiki, pageToChunkTexts, type WikiIngestDeps } from './ingest.ts';
import type { WikiPageOp } from './llm.ts';

const SRC = 'test:wiki-dream';
const WIKI = 'test:wiki';

function dreamChunk(
  id: string,
  sessionId: string,
  repo: string,
  kind: string,
  content: string,
  ts = 1_700_000_000_000,
  artifacts?: Artifact[]
): Chunk {
  return {
    id,
    embedding: [],
    content,
    metadata: {
      repo,
      branch: '',
      timestamp: new Date(ts),
      filePaths: [],
      exitCode: null,
      sessionId,
      cwd: '',
      tier: 'dream',
      owner: SRC,
      dreamType: kind,
      ...(artifacts ? { artifacts } : {}),
    },
  };
}

const LONG_BODY = 'pgvector backs the index. [[fingerprint-skip]] uses it. '.repeat(20); // >500 chars

// Script: unit s1 creates two interlinked pages; unit s2 tries to shrink pgvector.
function script(header: string): { pages: WikiPageOp[] } {
  if (header.includes('s2')) {
    return {
      pages: [{ slug: 'pgvector', action: 'update', kind: 'tool', title: 'pgvector', summary: 'x', aliases: [], body: 'tiny [[fingerprint-skip]]', sources: ['d3'] }],
    };
  }
  return {
    pages: [
      { slug: 'pgvector', action: 'create', kind: 'tool', title: 'pgvector', summary: 'the vector store', aliases: ['pg-vector'], body: LONG_BODY, sources: ['d1'] },
      { slug: 'fingerprint-skip', action: 'create', kind: 'decision', title: 'Fingerprint short-circuit', summary: 'skip unchanged units', aliases: [], body: 'The fingerprint skip relies on [[pgvector]].', sources: ['d2'] },
    ],
  };
}

function makeDeps(dir: string, llm: FakeWikiLLM): { backend: FakeBackend; deps: WikiIngestDeps } {
  const backend = new FakeBackend();
  const embedder = new Embedder(new FakeProvider({ dim: 4 }), backend);
  const store = new WikiStore(dir);
  return { backend, deps: { backend, store, embedder, llm, config: testConfig({ wikiDir: dir }) } };
}

describe('pageToChunkTexts', () => {
  test('single chunk under budget, splits on ## over budget', () => {
    expect(pageToChunkTexts('short body')).toHaveLength(1);
    const big = `intro\n${'## H\n'.padEnd(3000, 'x')}\n## Second\n${'y'.repeat(3000)}`;
    expect(pageToChunkTexts(big).length).toBeGreaterThan(1);
  });
});

describe('ingestWiki', () => {
  test('compiles pages with provenance + links, syncs pg, skips on re-run', async () => {
    const dir = join(tmpdir(), `engram-wiki-ingest-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(script);
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([
        dreamChunk('d1', 's1', 'engram', 'decision', 'we chose pgvector for the vector store'),
        dreamChunk('d2', 's1', 'engram', 'gotcha', 'fingerprint short-circuit skips unchanged units'),
      ]);

      const res = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect(res.unitsCompiled).toBe(1);
      expect(res.pagesCreated).toBe(2);
      expect(llm.callCount).toBe(1);

      // Pages on disk carry provenance + fingerprint + merged trajectory.
      const pg = deps.store.readPage('pgvector')!;
      expect(pg.sources).toContain('d1');
      expect(pg.trajectories[0]).toStartWith('dream:');
      expect(pg.fingerprint).toBeTruthy();

      // Links form both directions; index has no orphans.
      const graph = deps.store.linkGraph();
      expect(graph.inbound.get('pgvector')).toContain('fingerprint-skip');
      expect(graph.inbound.get('fingerprint-skip')).toContain('pgvector');

      // Embedded into pg under tier='wiki', owner WIKI, trajectory 'wiki:<slug>'.
      const traj = await backend.getTrajectory('wiki:pgvector');
      expect(traj.length).toBeGreaterThan(0);
      expect(traj[0]!.metadata.tier).toBe('wiki');
      expect(traj[0]!.metadata.owner).toBe(WIKI);

      // Ledger recorded.
      expect((await backend.getWikiUnits(WIKI)).length).toBe(1);

      // Re-run: fingerprint unchanged → 100% skip, no LLM calls.
      const before = llm.callCount;
      const rerun = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect(rerun.unitsSkipped).toBe(1);
      expect(rerun.pagesCreated).toBe(0);
      expect(llm.callCount).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shrink guard trip → retry still shrinks → deterministic addendum (knowledge kept)', async () => {
    const dir = join(tmpdir(), `engram-wiki-guard-${crypto.randomUUID()}`);
    // `script` returns the same tiny op for s2 regardless of correction → retry
    // still violates → addendum fallback.
    const llm = new FakeWikiLLM(script);
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector'), dreamChunk('d2', 's1', 'engram', 'gotcha', 'fp skip')]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      const bodyBefore = deps.store.readPage('pgvector')!.body;
      const callsBefore = llm.callCount;

      // New unit s2 tries to shrink pgvector below 40%.
      await backend.upsert([dreamChunk('d3', 's2', 'engram', 'decision', 'more pgvector notes')]);
      const res = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect(res.pagesSkippedGuard).toBe(1);
      expect(res.pagesRetried).toBe(0);
      expect(res.pagesAddendum).toBe(1);
      // A retry LLM call was made (pass-1 + retry = 2 more calls this run).
      expect(llm.callCount).toBe(callsBefore + 2);
      expect(llm.calls.some((c) => c.correction)).toBe(true);

      const body = deps.store.readPage('pgvector')!.body;
      expect(body).toStartWith(bodyBefore.trimEnd()); // old knowledge preserved verbatim
      expect(body).toContain('## Addendum (');
      expect(body).toContain('tiny'); // the would-be-lost new op body appended
      // Addendum grows the page; it never trips the guard itself.
      expect(res.pagesSkippedGuard).toBe(res.pagesRetried + res.pagesAddendum);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const FIRST_ATTEMPT = 'tiny [[fingerprint-skip]]';

  // s1 seeds a big pgvector page; s2 shrinks it. The retry behavior is driven by
  // whether a `correction` was supplied and what body it returns.
  function retryScript(onCorrection: (slug: string) => WikiPageOp[]) {
    return (header: string, _i: string, _c: string, _inv: string, correction?: string): { pages: WikiPageOp[] } => {
      if (header.includes('s2')) {
        if (correction) return { pages: onCorrection('pgvector') };
        return { pages: [{ slug: 'pgvector', action: 'update', kind: 'tool', title: 'pgvector', summary: 'x', aliases: [], body: FIRST_ATTEMPT, sources: ['d3'] }] };
      }
      return script(header);
    };
  }

  async function seedAndShrink(dir: string, llm: FakeWikiLLM) {
    const { backend, deps } = makeDeps(dir, llm);
    await backend.upsert([dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector'), dreamChunk('d2', 's1', 'engram', 'gotcha', 'fp skip')]);
    await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
    const bodyBefore = deps.store.readPage('pgvector')!.body;
    await backend.upsert([dreamChunk('d3', 's2', 'engram', 'decision', 'more pgvector notes')]);
    const res = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
    return { backend, deps, bodyBefore, res };
  }

  test('shrink retry succeeds: correction yields a proper merged body, written in place', async () => {
    const dir = join(tmpdir(), `engram-wiki-retry-ok-${crypto.randomUUID()}`);
    const mergedBody = LONG_BODY + '\nNew merged fact from s2. [[fingerprint-skip]]';
    const llm = new FakeWikiLLM(
      retryScript(() => [{ slug: 'pgvector', action: 'update', kind: 'tool', title: 'pgvector', summary: 'x', aliases: [], body: mergedBody, sources: ['d3'] }])
    );
    try {
      const { deps, bodyBefore, res } = await seedAndShrink(dir, llm);
      expect(res.pagesSkippedGuard).toBe(1);
      expect(res.pagesRetried).toBe(1);
      expect(res.pagesAddendum).toBe(0);

      const body = deps.store.readPage('pgvector')!.body;
      expect(body).toContain('New merged fact from s2');
      expect(body).not.toContain('## Addendum (');

      // The correction restated the slug, both char counts, and the FULL old body.
      const correction = llm.calls.find((c) => c.correction)!.correction!;
      expect(correction).toContain(`shrank pgvector from ${bodyBefore.length} to ${FIRST_ATTEMPT.length}`);
      expect(correction).toContain('below the 40% floor');
      expect(correction).toContain('pgvector backs the index'); // full old body re-supplied
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('still-shrinking retry that DROPPED the new facts → addendum from the ORIGINAL op, not the retry', async () => {
    const dir = join(tmpdir(), `engram-wiki-retry-degenerate-${crypto.randomUUID()}`);
    // Retry body is still tiny AND omits the pass-1 new fact — the addendum must
    // fall back to the original op so the unit's contribution survives.
    const llm = new FakeWikiLLM(
      retryScript(() => [{ slug: 'pgvector', action: 'update', kind: 'tool', title: 'pgvector', summary: 'x', aliases: [], body: 'degenerate retry', sources: ['d3'] }])
    );
    try {
      const { deps, bodyBefore, res } = await seedAndShrink(dir, llm);
      expect(res.pagesRetried).toBe(0);
      expect(res.pagesAddendum).toBe(1);
      const body = deps.store.readPage('pgvector')!.body;
      expect(body).toStartWith(bodyBefore.trimEnd());
      expect(body).toContain('tiny'); // ORIGINAL op body (the new facts)
      expect(body).not.toContain('degenerate retry'); // failed merge discarded
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shrink retry returns no op for the slug → addendum built from the ORIGINAL op body', async () => {
    const dir = join(tmpdir(), `engram-wiki-retry-noop-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(retryScript(() => [])); // retry yields nothing
    try {
      const { deps, bodyBefore, res } = await seedAndShrink(dir, llm);
      expect(res.pagesRetried).toBe(0);
      expect(res.pagesAddendum).toBe(1);
      const body = deps.store.readPage('pgvector')!.body;
      expect(body).toStartWith(bodyBefore.trimEnd());
      expect(body).toContain('## Addendum (');
      expect(body).toContain('tiny'); // ORIGINAL first-attempt body, since retry gave no op
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two violating slugs in one unit → exactly ONE retry call, independent outcomes', async () => {
    const dir = join(tmpdir(), `engram-wiki-retry-two-${crypto.randomUUID()}`);
    const BIG_A = 'alpha detail. [[beta]] links here. '.repeat(20);
    const BIG_B = 'beta detail. [[alpha]] links here. '.repeat(20);
    const mergedA = BIG_A + '\nmerged alpha fact. [[beta]]';
    // s1 creates alpha+beta (both >500). s2 shrinks both; retry rescues alpha only.
    const llm = new FakeWikiLLM((header, _i, _c, _inv, correction) => {
      if (header.includes('s1')) {
        return {
          pages: [
            { slug: 'alpha', action: 'create', kind: 'topic', title: 'Alpha', summary: 'a', aliases: [], body: BIG_A, sources: ['a1'] },
            { slug: 'beta', action: 'create', kind: 'topic', title: 'Beta', summary: 'b', aliases: [], body: BIG_B, sources: ['a2'] },
          ],
        };
      }
      if (correction) {
        return { pages: [{ slug: 'alpha', action: 'update', kind: 'topic', title: 'Alpha', summary: 'a', aliases: [], body: mergedA, sources: ['a3'] }] };
      }
      return {
        pages: [
          { slug: 'alpha', action: 'update', kind: 'topic', title: 'Alpha', summary: 'a', aliases: [], body: 'tiny a [[beta]]', sources: ['a3'] },
          { slug: 'beta', action: 'update', kind: 'topic', title: 'Beta', summary: 'b', aliases: [], body: 'tiny b [[alpha]]', sources: ['a3'] },
        ],
      };
    });
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([dreamChunk('a1', 's1', 'engram', 'decision', 'alpha'), dreamChunk('a2', 's1', 'engram', 'gotcha', 'beta')]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      await backend.upsert([dreamChunk('a3', 's2', 'engram', 'decision', 'both alpha and beta notes')]);
      const res = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);

      expect(res.pagesSkippedGuard).toBe(2);
      expect(res.pagesRetried).toBe(1); // alpha
      expect(res.pagesAddendum).toBe(1); // beta
      expect(llm.calls.filter((c) => c.correction).length).toBe(1); // ONE retry call for both

      expect(deps.store.readPage('alpha')!.body).toContain('merged alpha fact');
      expect(deps.store.readPage('alpha')!.body).not.toContain('## Addendum (');
      expect(deps.store.readPage('beta')!.body).toContain('## Addendum (');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shrink retry uses the SLIM path: pass-1 carries candidates+inventory, retry drops them', async () => {
    const dir = join(tmpdir(), `engram-wiki-retry-slim-${crypto.randomUUID()}`);
    const mergedBody = LONG_BODY + '\nNew merged fact from s2. [[fingerprint-skip]]';
    const llm = new FakeWikiLLM(
      retryScript(() => [{ slug: 'pgvector', action: 'update', kind: 'tool', title: 'pgvector', summary: 'x', aliases: [], body: mergedBody, sources: ['d3'] }])
    );
    try {
      await seedAndShrink(dir, llm);
      const pass1 = llm.calls.find((c) => c.header.includes('s2') && !c.correction)!;
      const retry = llm.calls.find((c) => c.correction)!;
      // Pass 1 sends the full candidate + inventory payload.
      expect(pass1.inventory.length).toBeGreaterThan(0);
      // The slim retry drops both (only header + items + correction go over the wire).
      expect(retry.candidatesText).toBe('');
      expect(retry.inventory).toBe('');
      expect(retry.header).toBe(pass1.header);
      expect(retry.itemsText).toBe(pass1.itemsText);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('retry op body is autolinked (sibling mention wrapped) before the guard re-check', async () => {
    const dir = join(tmpdir(), `engram-wiki-retry-autolink-${crypto.randomUUID()}`);
    // Merged retry body mentions the sibling's TITLE in PLAIN TEXT only — no
    // [[link]] at all, so a wrapped link in the stored body proves autolink ran
    // on the retry op. Long enough (>40% of the old body) to clear the guard.
    const mergedPlain = 'The vector store persists embeddings and relies on the Fingerprint short-circuit. '.repeat(15);
    const llm = new FakeWikiLLM(
      retryScript(() => [{ slug: 'pgvector', action: 'update', kind: 'tool', title: 'pgvector', summary: 'x', aliases: [], body: mergedPlain, sources: ['d3'] }])
    );
    try {
      const { deps, res } = await seedAndShrink(dir, llm);
      expect(res.pagesRetried).toBe(1);
      // The plain-text sibling mention was wrapped by autolink on the retry op.
      expect(deps.store.readPage('pgvector')!.body).toContain('[[fingerprint-skip');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  test('filters op sources to real item ids from the unit', async () => {
    const dir = join(tmpdir(), `engram-wiki-src-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(() => ({
      pages: [{ slug: 'pgvector', action: 'create' as const, kind: 'tool' as const, title: 'pgvector', summary: 'x', aliases: [], body: 'b [[fingerprint-skip]]', sources: ['d1', 'gotcha', 'made-up'] }],
    }));
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector')]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect(deps.store.readPage('pgvector')!.sources).toEqual(['d1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dry-run plans without writing or calling the LLM', async () => {
    const dir = join(tmpdir(), `engram-wiki-dry-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(script);
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector')]);
      const res = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: true }, deps);
      expect(res.dryRun).toBe(true);
      expect(res.plan?.length).toBe(1);
      expect(llm.callCount).toBe(0);
      expect(deps.store.listSlugs()).toEqual([]);
      expect(existsSync(dir)).toBe(false); // dry-run must not bootstrap the wiki dir
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('compiles units OLDEST-first with the session date in each header', async () => {
    const dir = join(tmpdir(), `engram-wiki-chrono-${crypto.randomUUID()}`);
    // One page per session so nothing clobbers; capture header order via the fake.
    const llm = new FakeWikiLLM((header) => ({
      pages: [
        header.includes('s-late')
          ? { slug: 'late', action: 'create' as const, kind: 'topic' as const, title: 'Late', summary: 'l', aliases: [], body: 'later knowledge [[early]]', sources: ['dl'] }
          : { slug: 'early', action: 'create' as const, kind: 'topic' as const, title: 'Early', summary: 'e', aliases: [], body: 'earlier knowledge here', sources: ['de'] },
      ],
    }));
    const { backend, deps } = makeDeps(dir, llm);
    try {
      // Insert newest first (mirrors pg DESC aggregation) so the ASC sort is exercised.
      await backend.upsert([
        dreamChunk('dl', 's-late', 'engram', 'decision', 'late decision', 1_700_000_000_000),
        dreamChunk('de', 's-early', 'engram', 'decision', 'early decision', 1_600_000_000_000),
      ]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);

      expect(llm.calls.length).toBe(2);
      expect(llm.calls[0]!.header).toContain('s-early'); // oldest compiled first
      expect(llm.calls[1]!.header).toContain('s-late');
      expect(llm.calls[0]!.header).toContain('session date 2020-'); // 1_600_000_000_000 → 2020-09
      expect(llm.calls[1]!.header).toContain('session date 2023-'); // 1_700_000_000_000 → 2023-11
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('auto-links a plain-text sibling mention the LLM did not link (edges guaranteed)', async () => {
    const dir = join(tmpdir(), `engram-wiki-autolink-${crypto.randomUUID()}`);
    // Both op bodies mention the sibling in PLAIN TEXT — zero [[links]] emitted.
    const llm = new FakeWikiLLM(() => ({
      pages: [
        { slug: 'pgvector', action: 'create' as const, kind: 'tool' as const, title: 'pgvector', summary: 'store', aliases: [], body: 'The vector store uses the fingerprint short-circuit to skip work.', sources: ['d1'] },
        { slug: 'fingerprint-skip', action: 'create' as const, kind: 'decision' as const, title: 'fingerprint short-circuit', summary: 'skip', aliases: [], body: 'This decision relies on pgvector heavily for storage.', sources: ['d2'] },
      ],
    }));
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([
        dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector'),
        dreamChunk('d2', 's1', 'engram', 'gotcha', 'fp skip'),
      ]);
      const res = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect(res.pagesAutolinked).toBe(2);

      // Bodies were rewritten to carry the [[links]] the LLM omitted.
      expect(deps.store.readPage('pgvector')!.body).toContain('[[fingerprint-skip|fingerprint short-circuit]]');
      expect(deps.store.readPage('fingerprint-skip')!.body).toContain('[[pgvector]]');

      // Graph now has edges both directions; neither page is link-less.
      const graph = deps.store.linkGraph();
      expect(graph.inbound.get('fingerprint-skip')).toContain('pgvector');
      expect(graph.inbound.get('pgvector')).toContain('fingerprint-skip');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const HOTKEY: Artifact = { kind: 'file', ref: 'src/desktop/hotkey.rs', tool: 'Write' };
  const PR: Artifact = { kind: 'pr', ref: 'https://github.com/org/repo/pull/42', tool: 'gh' };

  test('derives page artifacts as the union over source dream chunks (body + fingerprint untouched)', async () => {
    const dir = join(tmpdir(), `engram-wiki-artifacts-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(() => ({
      pages: [
        { slug: 'pgvector', action: 'create' as const, kind: 'tool' as const, title: 'pgvector', summary: 'store', aliases: [], body: 'The vector store. [[fingerprint-skip]]', sources: ['d1'] },
        { slug: 'fingerprint-skip', action: 'create' as const, kind: 'decision' as const, title: 'fp', summary: 'skip', aliases: [], body: 'Relies on [[pgvector]].', sources: ['d2'] },
      ],
    }));
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([
        dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector', 1_700_000_000_000, [HOTKEY]),
        dreamChunk('d2', 's1', 'engram', 'gotcha', 'fp skip', 1_700_000_000_000, [PR]),
      ]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);

      const pg = deps.store.readPage('pgvector')!;
      expect(pg.artifacts).toEqual([HOTKEY]);
      // SACRED: fingerprint = sha256 of sorted sources only; artifacts excluded.
      expect(pg.fingerprint).toBe(pageFingerprint(pg.sources));
      // Body is model-owned: no artifacts section, no artifact ref injected.
      expect(pg.body).not.toContain('hotkey.rs');
      expect(pg.body).not.toContain('artifacts');

      expect(deps.store.readPage('fingerprint-skip')!.artifacts).toEqual([PR]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recomputes artifacts each ingest: a source losing its artifact drops it from frontmatter', async () => {
    const dir = join(tmpdir(), `engram-wiki-artifacts-drop-${crypto.randomUUID()}`);
    const BODY = 'The vector store persists embeddings across sessions.';
    const llm = new FakeWikiLLM(() => ({
      pages: [{ slug: 'pgvector', action: 'update' as const, kind: 'tool' as const, title: 'pgvector', summary: 'x', aliases: [], body: BODY, sources: ['d1', 'd2'] }],
    }));
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector', 1_700_000_000_000, [HOTKEY])]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect(deps.store.readPage('pgvector')!.artifacts).toEqual([HOTKEY]);

      // Re-synthesis: d1 loses HOTKEY and a new dream chunk d2 (no artifact) appears,
      // so the unit fingerprint changes and ingest re-runs the unit → recompute.
      backend.chunks.get('d1')!.metadata.artifacts = [];
      await backend.upsert([dreamChunk('d2', 's1', 'engram', 'note', 'later note', 1_700_000_000_001)]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);

      const pg = deps.store.readPage('pgvector')!;
      expect([...pg.sources].sort()).toEqual(['d1', 'd2']);
      expect(pg.artifacts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reindex drops pg chunks for deleted pages', async () => {
    const dir = join(tmpdir(), `engram-wiki-reindex-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(script);
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector'), dreamChunk('d2', 's1', 'engram', 'gotcha', 'fp skip')]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect((await backend.listWikiChunkIds(WIKI)).length).toBeGreaterThan(0);

      // Delete a page file, then reconcile.
      rmSync(deps.store.pagePath('pgvector'));
      const res = await reindexWiki(WIKI, { backend, store: deps.store, embedder: deps.embedder });
      expect(res.pages).toBe(1);
      expect(res.dropped).toBeGreaterThan(0);
      expect(await backend.getTrajectory('wiki:pgvector')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
