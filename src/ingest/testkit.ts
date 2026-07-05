import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chunk, EngramConfig, RawEvent, SearchFilters, SearchResult, ToolCall, Trajectory } from '../types/index.ts';
import type { DreamStore, DreamUnitRow, EmbeddingCache, PendingUnit, SynthesisUnit, VectorBackend, WikiEvidenceStore, WikiLedger, WikiPageEvidence, WikiUnitRow } from '../storage/backend.ts';
import type { EmbeddingProvider, ProviderEmbedding } from './embed.ts';
import type { DreamExtraction, DreamItem, DreamLLM } from '../dream/llm.ts';
import type { WikiIngestLLM, WikiIngestResponse, WikiSplitLLM } from '../wiki/llm.ts';
import type { WikiPage } from '../wiki/store.ts';
import { LocalStore } from '../storage/local.ts';

// ---------------------------------------------------------------------------
// Deterministic embedding provider
// ---------------------------------------------------------------------------

// A provider whose vectors are a pure function of the input text, so tests can
// recompute the exact vector a cache miss must produce. Counts calls + records
// inputs to prove the cache short-circuits the provider.
export class FakeProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  readonly maxInputChars?: number;
  callCount = 0;
  calls: string[][] = [];

  constructor(opts: { model?: string; dim?: number; maxInputChars?: number } = {}) {
    this.model = opts.model ?? 'fake-model';
    this.dim = opts.dim ?? 4;
    this.maxInputChars = opts.maxInputChars;
  }

  vec(text: string): number[] {
    // Cheap deterministic hash spread across `dim` slots.
    const out = new Array<number>(this.dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      out[i % this.dim]! += text.charCodeAt(i);
    }
    return out.map((v) => v / (text.length + 1));
  }

  async embed(texts: string[]): Promise<ProviderEmbedding> {
    this.callCount++;
    this.calls.push([...texts]);
    return { vectors: texts.map((t) => this.vec(t)), model: this.model };
  }
}

// ---------------------------------------------------------------------------
// In-memory embedding cache
// ---------------------------------------------------------------------------

export class FakeCache implements EmbeddingCache {
  private store = new Map<string, number[]>();
  getCalls = 0;
  putCalls = 0;

  private key(sha: string, model: string): string {
    return `${model}\n${sha}`;
  }

  seed(sha: string, model: string, embedding: number[]): void {
    this.store.set(this.key(sha, model), embedding);
  }

  async getCachedEmbeddings(shas: string[], model: string): Promise<Map<string, number[]>> {
    this.getCalls++;
    const out = new Map<string, number[]>();
    for (const sha of shas) {
      const hit = this.store.get(this.key(sha, model));
      if (hit) out.set(sha, hit);
    }
    return out;
  }

  async putCachedEmbeddings(entries: Array<{ sha: string; embedding: number[] }>, model: string): Promise<void> {
    this.putCalls++;
    for (const e of entries) {
      const k = this.key(e.sha, model);
      if (!this.store.has(k)) this.store.set(k, e.embedding); // ON CONFLICT DO NOTHING
    }
  }
}

// Concrete tier set for a SearchFilters tier, or null for "no filter".
function tierSet(tier: SearchFilters['tier']): Set<string> | null {
  switch (tier) {
    case 'raw':
    case 'dream':
    case 'wiki':
      return new Set([tier]);
    case 'synth':
      return new Set(['wiki', 'dream']);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory VectorBackend mirroring pgvector's conflict semantics
// ---------------------------------------------------------------------------

export class FakeBackend implements VectorBackend, DreamStore, WikiLedger, WikiEvidenceStore {
  readonly rawEvents = new Map<string, RawEvent>(); // keyed by content_sha256 (unique)
  readonly chunks = new Map<string, Chunk>(); // keyed by id (primary key)
  readonly dreamUnits = new Map<string, DreamUnitRow>(); // keyed by owner\nsessionId\nrepo
  readonly wikiUnits = new Map<string, WikiUnitRow>(); // keyed by owner\nsessionId\nrepo
  private cache = new FakeCache();

  // Mirror of pgvector's chunker_version stamp: the backend-level version every
  // upsert writes (tests flip this to simulate a chunker upgrade), and the
  // per-row stamps it produces. On an id conflict the stamp is RESTAMPED while
  // the chunk row keeps DO NOTHING semantics — exactly pgvector's upsert.
  chunkerVersion = 'v2';
  readonly chunkerVersions = new Map<string, string>(); // chunk id → stamped version

  insertRawEventsCalls = 0;
  upsertCalls = 0;
  // Ids passed to deleteChunksByIds, in call order (V2 supersession assertions).
  deletedIds: string[] = [];
  // Set to throw from upsert. Receives the 0-based upsert call index (pre-increment).
  upsertHook?: (chunks: Chunk[], callIndex: number) => void;

  async initialize(): Promise<void> {}

  async insertRawEvents(events: RawEvent[]): Promise<number> {
    this.insertRawEventsCalls++;
    let inserted = 0;
    for (const e of events) {
      if (!this.rawEvents.has(e.contentSha256)) {
        this.rawEvents.set(e.contentSha256, e);
        inserted++;
      }
    }
    return inserted;
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    const callIndex = this.upsertCalls;
    this.upsertCalls++;
    // Throw BEFORE mutating state, exactly like a DB whose transaction aborted:
    // the rows never landed.
    this.upsertHook?.(chunks, callIndex);
    for (const c of chunks) {
      if (!this.chunks.has(c.id)) this.chunks.set(c.id, c); // ON CONFLICT (id) DO NOTHING
      this.chunkerVersions.set(c.id, this.chunkerVersion); // …DO UPDATE SET chunker_version
    }
  }

  async getCachedEmbeddings(shas: string[], model: string): Promise<Map<string, number[]>> {
    return this.cache.getCachedEmbeddings(shas, model);
  }

  async putCachedEmbeddings(entries: Array<{ sha: string; embedding: number[] }>, model: string): Promise<void> {
    return this.cache.putCachedEmbeddings(entries, model);
  }

  async search(queryEmbedding: number[], _queryText: string, filters: SearchFilters): Promise<SearchResult[]> {
    const allowed = tierSet(filters.tier);
    const rows = [...this.chunks.values()].filter(
      (c) => (!filters.owner || c.metadata.owner === filters.owner) && (!allowed || allowed.has(c.metadata.tier))
    );
    const scored = rows.map((chunk) => {
      const dot = chunk.embedding.reduce((s, v, i) => s + v * (queryEmbedding[i] ?? 0), 0);
      return { chunk, similarity: dot, keywordRank: 0, combined: dot };
    });
    scored.sort((a, b) => b.combined - a.combined);
    return scored.slice(0, filters.limit ?? 5);
  }

  async getTrajectory(trajectoryId: string): Promise<Chunk[]> {
    return [...this.chunks.values()]
      .filter((c) => c.metadata.trajectoryId === trajectoryId)
      .sort((a, b) => (a.metadata.chunkIndex ?? 0) - (b.metadata.chunkIndex ?? 0));
  }

  async count(): Promise<number> {
    return this.chunks.size;
  }

  // Mirrors PgVectorBackend.deleteChunksByStaleVersion (MaintenanceStore): sweep
  // an owner's chunks of one tier whose stamped version differs from
  // currentVersion. A missing stamp counts as differing (IS DISTINCT FROM NULL).
  async deleteChunksByStaleVersion(owner: string, tier: string, currentVersion: string): Promise<number> {
    let n = 0;
    for (const [id, c] of this.chunks) {
      if (c.metadata.owner !== owner || c.metadata.tier !== tier) continue;
      if (this.chunkerVersions.get(id) === currentVersion) continue;
      this.chunks.delete(id);
      this.chunkerVersions.delete(id);
      n++;
    }
    return n;
  }

  // Mirrors PgVectorBackend.deleteByOwner (not on the VectorBackend interface).
  deleteByOwner(owner: string): { chunks: number; rawEvents: number } {
    let chunks = 0;
    for (const [id, c] of this.chunks) {
      if (c.metadata.owner === owner) {
        this.chunks.delete(id);
        chunks++;
      }
    }
    let rawEvents = 0;
    for (const [sha, e] of this.rawEvents) {
      if (e.owner === owner) {
        this.rawEvents.delete(sha);
        rawEvents++;
      }
    }
    for (const [k, u] of this.dreamUnits) {
      if (u.owner === owner) this.dreamUnits.delete(k);
    }
    for (const [k, u] of this.wikiUnits) {
      if (u.owner === owner) this.wikiUnits.delete(k);
    }
    return { chunks, rawEvents };
  }

  // --- DreamStore: mirrors pgvector's aggregation + upsert-on-conflict --------

  private unitKey(owner: string, sessionId: string, repo: string): string {
    return `${owner}\n${sessionId}\n${repo}`;
  }

  private aggregateUnits(
    tier: 'raw' | 'dream',
    owner: string,
    opts: { repo?: string; since?: Date; sessionId?: string }
  ): SynthesisUnit[] {
    const groups = new Map<string, Chunk[]>();
    for (const c of this.chunks.values()) {
      if (c.metadata.tier !== tier || c.metadata.owner !== owner) continue;
      const repo = c.metadata.repo ?? '';
      if (opts.repo !== undefined && repo !== opts.repo) continue;
      if (opts.sessionId !== undefined && c.metadata.sessionId !== opts.sessionId) continue;
      const key = `${c.metadata.sessionId}\n${repo}`;
      let members = groups.get(key);
      if (!members) groups.set(key, (members = []));
      members.push(c);
    }
    const units: SynthesisUnit[] = [];
    for (const [key, members] of groups) {
      const [sessionId, repo] = key.split('\n') as [string, string];
      const lastTimestamp = new Date(Math.max(...members.map((m) => m.metadata.timestamp.getTime())));
      if (opts.since && lastTimestamp < opts.since) continue;
      units.push({
        sessionId,
        repo,
        chunkIds: members.map((m) => m.id).sort(),
        totalChars: members.reduce((s, m) => s + m.content.length, 0),
        lastTimestamp,
      });
    }
    units.sort((a, b) => b.lastTimestamp.getTime() - a.lastTimestamp.getTime());
    return units;
  }

  async listSynthesisUnits(opts: { owner: string; repo?: string; since?: Date; sessionId?: string }): Promise<SynthesisUnit[]> {
    return this.aggregateUnits('raw', opts.owner, opts);
  }

  async getUnitChunks(owner: string, sessionId: string, repo: string, tier: 'raw' | 'dream' = 'raw'): Promise<Chunk[]> {
    return [...this.chunks.values()]
      .filter(
        (c) =>
          c.metadata.tier === tier &&
          c.metadata.owner === owner &&
          c.metadata.sessionId === sessionId &&
          (c.metadata.repo ?? '') === repo
      )
      .sort(
        (a, b) =>
          a.metadata.timestamp.getTime() - b.metadata.timestamp.getTime() ||
          (a.metadata.chunkIndex ?? 0) - (b.metadata.chunkIndex ?? 0)
      );
  }

  async getDreamUnits(owner: string): Promise<DreamUnitRow[]> {
    return [...this.dreamUnits.values()].filter((u) => u.owner === owner);
  }

  async upsertDreamUnit(row: DreamUnitRow): Promise<void> {
    this.dreamUnits.set(this.unitKey(row.owner, row.sessionId, row.repo), { ...row });
  }

  async deleteChunksByIds(ids: string[], owner: string, tier: string): Promise<number> {
    this.deletedIds.push(...ids);
    let n = 0;
    for (const id of ids) {
      const c = this.chunks.get(id);
      if (c && c.metadata.tier === tier && c.metadata.owner === owner) {
        this.chunks.delete(id);
        this.chunkerVersions.delete(id);
        n++;
      }
    }
    return n;
  }

  async deleteDreamChunks(ids: string[], owner: string): Promise<number> {
    return this.deleteChunksByIds(ids, owner, 'dream');
  }

  // --- WikiLedger ------------------------------------------------------------

  async listDreamUnitsAsUnits(owner: string, opts: { repo?: string; since?: Date } = {}): Promise<SynthesisUnit[]> {
    return this.aggregateUnits('dream', owner, opts);
  }

  async listWikiChunkIds(owner: string): Promise<Array<{ id: string; trajectoryId: string | null }>> {
    return [...this.chunks.values()]
      .filter((c) => c.metadata.tier === 'wiki' && c.metadata.owner === owner)
      .map((c) => ({ id: c.id, trajectoryId: c.metadata.trajectoryId ?? null }));
  }

  async getWikiUnits(owner: string): Promise<WikiUnitRow[]> {
    return [...this.wikiUnits.values()].filter((u) => u.owner === owner);
  }

  async upsertWikiUnit(row: WikiUnitRow): Promise<void> {
    this.wikiUnits.set(this.unitKey(row.owner, row.sessionId, row.repo), { ...row });
  }

  // --- WikiEvidenceStore -----------------------------------------------------

  async existingChunkIds(ids: string[], tier: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const id of ids) {
      const c = this.chunks.get(id);
      if (c && c.metadata.tier === tier) out.add(id);
    }
    return out;
  }

  // The fake carries no dream_units.synthesized_at, so it can't reproduce the
  // 48h staleness gate — always empty. The pending-unit decision is covered by
  // pendingUnitsFrom's own unit tests (src/wiki/lint.test.ts).
  async pendingWikiUnits(_owner: string, _staleHours = 48): Promise<PendingUnit[]> {
    return [];
  }

  async wikiPageEvidence(sourceIds: string[]): Promise<WikiPageEvidence> {
    const sessions = new Set<string>();
    let first: number | null = null;
    let last: number | null = null;
    for (const id of sourceIds) {
      const c = this.chunks.get(id);
      if (!c) continue;
      if (c.metadata.sessionId) sessions.add(c.metadata.sessionId);
      const t = c.metadata.timestamp?.getTime();
      if (t != null && !Number.isNaN(t)) {
        first = first == null ? t : Math.min(first, t);
        last = last == null ? t : Math.max(last, t);
      }
    }
    return {
      sessionCount: sessions.size,
      firstSeen: first == null ? null : new Date(first),
      lastSeen: last == null ? null : new Date(last),
    };
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Scripted dream LLM
// ---------------------------------------------------------------------------

// Returns pre-scripted extractions keyed by unit header (or a default), so tests
// can assert the fingerprint short-circuit skips units without re-invoking it.
export class FakeDreamLLM implements DreamLLM {
  callCount = 0;
  calls: Array<{ header: string; transcript: string }> = [];

  constructor(
    private script: (header: string, transcript: string) => DreamExtraction | DreamItem[]
  ) {}

  async extract(header: string, transcript: string): Promise<DreamExtraction> {
    this.callCount++;
    this.calls.push({ header, transcript });
    const out = this.script(header, transcript);
    const res = Array.isArray(out) ? { items: out } : out;
    return {
      items: res.items,
      usage: res.usage ?? { promptTokens: transcript.length, completionTokens: res.items.length * 20 },
    };
  }
}

// ---------------------------------------------------------------------------
// Scripted wiki ingest LLM
// ---------------------------------------------------------------------------

// Returns pre-scripted page ops keyed by the unit header + item texts, so tests
// assert the fingerprint short-circuit skips units without re-invoking it.
export class FakeWikiLLM implements WikiIngestLLM, WikiSplitLLM {
  callCount = 0;
  splitCallCount = 0;
  calls: Array<{ header: string; itemsText: string; candidatesText: string; inventory: string; correction?: string }> = [];
  splitCalls: Array<{ page: WikiPage; inventory: string }> = [];

  constructor(
    private script: (
      header: string,
      itemsText: string,
      candidatesText: string,
      inventory: string,
      correction?: string
    ) => WikiIngestResponse,
    // Optional scripted split for the hub-split path.
    private splitScript?: (page: WikiPage, inventory: string) => WikiIngestResponse
  ) {}

  async ingest(
    header: string,
    itemsText: string,
    candidatesText: string,
    inventory: string,
    correction?: string
  ): Promise<WikiIngestResponse> {
    this.callCount++;
    this.calls.push({ header, itemsText, candidatesText, inventory, correction });
    const out = this.script(header, itemsText, candidatesText, inventory, correction);
    return {
      pages: out.pages,
      usage: out.usage ?? { promptTokens: itemsText.length, completionTokens: out.pages.length * 40 },
    };
  }

  // Slim shrink-guard retry: records candidatesText/inventory as '' so tests can
  // prove pass 1's payload was dropped, while still driving the same script's
  // `correction` branch.
  async ingestRetry(header: string, itemsText: string, correction: string): Promise<WikiIngestResponse> {
    this.callCount++;
    this.calls.push({ header, itemsText, candidatesText: '', inventory: '', correction });
    const out = this.script(header, itemsText, '', '', correction);
    return {
      pages: out.pages,
      usage: out.usage ?? { promptTokens: itemsText.length, completionTokens: out.pages.length * 40 },
    };
  }

  async split(page: WikiPage, inventory: string): Promise<WikiIngestResponse> {
    this.splitCallCount++;
    this.splitCalls.push({ page, inventory });
    if (!this.splitScript) throw new Error('FakeWikiLLM: no split script provided');
    const out = this.splitScript(page, inventory);
    return {
      pages: out.pages,
      usage: out.usage ?? { promptTokens: page.body.length, completionTokens: out.pages.length * 40 },
    };
  }
}

// ---------------------------------------------------------------------------
// Config + LocalStore helpers
// ---------------------------------------------------------------------------

export function testConfig(overrides: Partial<EngramConfig> = {}): EngramConfig {
  return {
    databaseUrl: '',
    openaiApiKey: '',
    embeddingProvider: 'local',
    embeddingModel: 'fake-model',
    embeddingDim: 4,
    watchPath: '',
    sessionCompleteDelaySec: 8,
    chunkBatchSize: 32,
    vectorWeight: 0.7,
    keywordWeight: 0.3,
    timeDecayHalfLifeDays: 0,
    rerank: { enabled: false, model: 'gpt-4.1-mini', topK: 30 },
    dreamModel: 'fake-dream-model',
    dreamMaxInputChars: 200_000,
    wikiDir: join(tmpdir(), `engram-wiki-${crypto.randomUUID()}`),
    wikiModel: 'fake-wiki-model',
    wikiMaxInputChars: 60_000,
    synthesis: { enabled: false, hour: 3, targetedSessionsPerNight: 5 },
    contextInjection: { enabled: true, budget: 1500 },
    ...overrides,
  };
}

export interface TempStore {
  store: LocalStore;
  cleanup: () => void;
}

export function tempStore(): TempStore {
  const path = join(tmpdir(), `engram-test-${crypto.randomUUID()}.sqlite`);
  const store = new LocalStore(path);
  return {
    store,
    cleanup: () => {
      store.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          rmSync(path + suffix);
        } catch {
          // best effort
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Seeded generators for property-style tests
// ---------------------------------------------------------------------------

// mulberry32 — small deterministic PRNG so property tests are reproducible.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function words(next: () => number, count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push('w' + Math.floor(next() * 100000).toString(36));
  return parts.join(' ');
}

// Generate a trajectory of a varied but bounded size. `scale` inflates segment
// lengths to force multi-chunk output and (at large scale) hard-splits.
export function genTrajectory(next: () => number, scale = 1): Trajectory {
  const userLen = 3 + Math.floor(next() * 40 * scale);
  const blockCount = Math.floor(next() * 6 * scale);
  const toolCount = Math.floor(next() * 5 * scale);

  const assistantBlocks: string[] = [];
  for (let i = 0; i < blockCount; i++) {
    assistantBlocks.push(words(next, 5 + Math.floor(next() * 80 * scale)));
  }
  const toolCalls: ToolCall[] = [];
  for (let i = 0; i < toolCount; i++) {
    toolCalls.push({
      name: 'Tool' + Math.floor(next() * 5),
      input: { arg: words(next, 3 + Math.floor(next() * 40 * scale)) },
      output: next() > 0.5 ? words(next, 5 + Math.floor(next() * 60 * scale)) : undefined,
      isError: next() > 0.9,
    });
  }

  return {
    sessionId: 'sess-' + Math.floor(next() * 1000),
    repo: 'engram',
    branch: 'main',
    cwd: '/tmp/engram',
    timestamp: new Date(1_700_000_000_000 + Math.floor(next() * 1_000_000)),
    userMessage: words(next, userLen),
    assistantBlocks,
    toolCalls,
    filePaths: [],
    artifacts: [],
    exitCode: null,
  };
}
