import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chunk, EmbeddedChunk, EngramConfig, RawEvent, SearchFilters, SearchResult, ToolCall, Trajectory } from '../types/index.ts';
import type { CaptionCache, DailyChunkStat, DreamStore, DreamUnitRow, DreamUnitWikiRow, EmbeddingCache, SynthesisUnit, VectorBackend, WikiEvidenceStore, WikiLedger, WikiPageEvidence, WikiUnitRow } from '../storage/backend.ts';
import { CHUNKER_VERSION } from '../types/index.ts';
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

export class FakeBackend implements VectorBackend, CaptionCache, DreamStore, WikiLedger, WikiEvidenceStore {
  readonly rawEvents = new Map<string, RawEvent>(); // keyed by content_sha256 (unique)
  readonly chunks = new Map<string, EmbeddedChunk>(); // keyed by id (primary key)
  readonly dreamUnits = new Map<string, DreamUnitRow>(); // keyed by owner\nsessionId\nrepo
  readonly wikiUnits = new Map<string, WikiUnitRow>(); // keyed by owner\nsessionId\nrepo
  private cache = new FakeCache();

  // Mirror of pgvector's chunker_version stamp: the backend-level version every
  // upsert writes (tests flip this to simulate a chunker upgrade), and the
  // per-row stamps it produces. On an id conflict the stamp is RESTAMPED while
  // the chunk row keeps DO NOTHING semantics — exactly pgvector's upsert.
  chunkerVersion = CHUNKER_VERSION;
  readonly chunkerVersions = new Map<string, string>(); // chunk id → stamped version

  // In-memory caption cache, keyed `${model}\n${sha}`. Counters prove the pipeline
  // hits the cache (getCaptionCalls) and persists only successful LLM captions.
  private captions = new Map<string, string>();
  getCaptionCalls = 0;
  putCaptionCalls = 0;

  insertRawEventsCalls = 0;
  upsertCalls = 0;
  // Ids passed to deleteChunksByIds, in call order (V2 supersession assertions).
  // HARD deletes only — pipeline tests depend on this; soft invalidations
  // record into invalidatedIds instead.
  deletedIds: string[] = [];
  // Ids passed to invalidateChunks, in call order (soft-supersession assertions).
  invalidatedIds: string[] = [];
  // Set to throw from upsert. Receives the 0-based upsert call index (pre-increment).
  upsertHook?: (chunks: EmbeddedChunk[], callIndex: number) => void;

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

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    const callIndex = this.upsertCalls;
    this.upsertCalls++;
    // Throw BEFORE mutating state, exactly like a DB whose transaction aborted:
    // the rows never landed.
    this.upsertHook?.(chunks, callIndex);
    for (const c of chunks) {
      const existing = this.chunks.get(c.id);
      if (!existing) {
        this.chunks.set(c.id, c); // ON CONFLICT (id) DO NOTHING for the row…
      } else {
        // …except the tombstone: a re-upsert of an invalidated id RESURRECTS it
        // (…DO UPDATE SET invalid_at = NULL, superseded_by = NULL) — exactly
        // pgvector's conflict clause. All other columns keep the existing row.
        delete existing.metadata.invalidAt;
        delete existing.metadata.supersededBy;
      }
      this.chunkerVersions.set(c.id, this.chunkerVersion); // …DO UPDATE SET chunker_version
    }
  }

  // Non-invalidated chunks — the live view every filtered read path serves.
  // Returns the stored write shape (with embedding) for direct test assertions;
  // the VectorBackend read paths below strip it via readShape.
  liveChunks(): EmbeddedChunk[] {
    return [...this.chunks.values()].filter((c) => c.metadata.invalidAt === undefined);
  }

  // Mirror of rowToChunk: reads never return the vector. Keeps the fake's read
  // paths shape-identical to pgvector so `'embedding' in chunk` can't diverge
  // between unit and live tests.
  private readShape({ embedding: _embedding, ...chunk }: EmbeddedChunk): Chunk {
    return chunk;
  }

  async getCachedEmbeddings(shas: string[], model: string): Promise<Map<string, number[]>> {
    return this.cache.getCachedEmbeddings(shas, model);
  }

  async putCachedEmbeddings(entries: Array<{ sha: string; embedding: number[] }>, model: string): Promise<void> {
    return this.cache.putCachedEmbeddings(entries, model);
  }

  private captionKey(sha: string, model: string): string {
    return `${model}\n${sha}`;
  }

  // Seed a caption directly (simulate a prior successful LLM caption).
  seedCaption(sha: string, model: string, caption: string): void {
    this.captions.set(this.captionKey(sha, model), caption);
  }

  async getCachedCaptions(shas: string[], model: string): Promise<Map<string, string>> {
    this.getCaptionCalls++;
    const out = new Map<string, string>();
    for (const sha of shas) {
      const hit = this.captions.get(this.captionKey(sha, model));
      if (hit !== undefined) out.set(sha, hit);
    }
    return out;
  }

  async putCachedCaptions(entries: Array<{ sha: string; caption: string }>, model: string): Promise<void> {
    this.putCaptionCalls++;
    for (const e of entries) {
      const k = this.captionKey(e.sha, model);
      if (!this.captions.has(k)) this.captions.set(k, e.caption); // ON CONFLICT DO NOTHING
    }
  }

  async search(queryEmbedding: number[], _queryText: string, filters: SearchFilters): Promise<SearchResult[]> {
    const allowed = tierSet(filters.tier);
    const rows = [...this.chunks.values()].filter(
      (c) =>
        (!filters.owner || c.metadata.owner === filters.owner) &&
        (!allowed || allowed.has(c.metadata.tier)) &&
        ((filters.includeSuperseded ?? false) || c.metadata.invalidAt === undefined)
    );
    const scored = rows.map((chunk) => {
      const dot = chunk.embedding.reduce((s, v, i) => s + v * (queryEmbedding[i] ?? 0), 0);
      return { chunk: this.readShape(chunk), similarity: dot, keywordScore: 0, combined: dot };
    });
    scored.sort((a, b) => b.combined - a.combined);
    return scored.slice(0, filters.limit ?? 5);
  }

  async getTrajectory(trajectoryId: string): Promise<Chunk[]> {
    return this.liveChunks()
      .filter((c) => c.metadata.trajectoryId === trajectoryId)
      .sort((a, b) => (a.metadata.chunkIndex ?? 0) - (b.metadata.chunkIndex ?? 0))
      .map((c) => this.readShape(c));
  }

  async count(): Promise<number> {
    return this.liveChunks().length;
  }

  // Mirrors PgVectorBackend.dailyChunkCounts: (day, tier) formation buckets in
  // [since, until), keyed by metadata.timestamp (the fake has no created_at),
  // invalidated chunks included, sorted by day.
  async dailyChunkCounts(owner: string, since: Date, until: Date): Promise<DailyChunkStat[]> {
    const buckets = new Map<string, DailyChunkStat>();
    for (const c of this.chunks.values()) {
      if (c.metadata.owner !== owner) continue;
      const ts = c.metadata.timestamp.getTime();
      if (ts < since.getTime() || ts >= until.getTime()) continue;
      const day = c.metadata.timestamp.toISOString().slice(0, 10);
      const tier = c.metadata.tier ?? 'raw';
      const key = `${day}\n${tier}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { day, tier, chunks: 0, chars: 0 }));
      b.chunks++;
      b.chars += c.content.length;
    }
    return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  async earliestChunkDay(owner: string): Promise<string | null> {
    let min: string | null = null;
    for (const c of this.chunks.values()) {
      if (c.metadata.owner !== owner) continue;
      const day = c.metadata.timestamp.toISOString().slice(0, 10);
      if (min === null || day < min) min = day;
    }
    return min;
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
    // Invalidated chunks are excluded — equivalent to the old post-delete
    // state, so the unit fingerprints (sha256 of the id set) are unchanged.
    const groups = new Map<string, Chunk[]>();
    for (const c of this.liveChunks()) {
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
    // Live-only, like pgvector: the returned id set feeds dream/wiki
    // fingerprints, and filtering invalidated rows is exactly equivalent to the
    // old post-delete state.
    return this.liveChunks()
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
      )
      .map((c) => this.readShape(c));
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

  // Mirrors PgVectorBackend.invalidateChunks: tombstone (never delete), skip
  // already-invalid rows so the first tombstone is preserved, owner+tier-scoped.
  async invalidateChunks(ids: string[], owner: string, tier: string, supersededBy: string | null): Promise<number> {
    this.invalidatedIds.push(...ids);
    let n = 0;
    for (const id of ids) {
      const c = this.chunks.get(id);
      if (!c || c.metadata.tier !== tier || c.metadata.owner !== owner) continue;
      if (c.metadata.invalidAt !== undefined) continue; // AND invalid_at IS NULL
      c.metadata.invalidAt = new Date();
      c.metadata.supersededBy = supersededBy;
      n++;
    }
    return n;
  }

  async invalidateDreamChunks(ids: string[], owner: string, supersededBy: string | null): Promise<number> {
    return this.invalidateChunks(ids, owner, 'dream', supersededBy);
  }

  // --- WikiLedger ------------------------------------------------------------

  async listDreamUnitsAsUnits(owner: string, opts: { repo?: string; since?: Date } = {}): Promise<SynthesisUnit[]> {
    return this.aggregateUnits('dream', owner, opts);
  }

  async listWikiChunkIds(owner: string): Promise<Array<{ id: string; trajectoryId: string | null }>> {
    return this.liveChunks()
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

  // Deliberately unfiltered by invalidAt (existence semantics), like pgvector.
  async existingChunkIds(ids: string[], tier: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const id of ids) {
      const c = this.chunks.get(id);
      if (c && c.metadata.tier === tier) out.add(id);
    }
    return out;
  }

  // The fake carries no dream_units, so it has no rows to join — always empty.
  // The pending-unit decision over these rows is covered by pendingUnitsFrom's
  // own unit tests (src/wiki/lint.test.ts).
  async dreamUnitsWithWikiFingerprint(_owner: string, _cutoff: Date): Promise<DreamUnitWikiRow[]> {
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
    scoring: {
      vectorWeight: 0.7,
      keywordWeight: 0.3,
      timeDecayHalfLifeDays: 0,
      recencyWeight: 0.1,
      recencyHalfLifeDays: 30,
      importanceWeight: 0.1,
    },
    rerank: { enabled: false, model: 'gpt-4.1-mini', topK: 30 },
    imageCaption: { enabled: false, model: 'fake-caption-model', maxPerTrajectory: 4 },
    dreamModel: 'fake-dream-model',
    dreamMaxInputChars: 200_000,
    wikiDir: join(tmpdir(), `engram-wiki-${crypto.randomUUID()}`),
    wikiModel: 'fake-wiki-model',
    wikiMaxInputChars: 60_000,
    askModel: 'fake-ask-model',
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
  // 0–2 short thinking blocks so the new thinking role class exercises packing.
  const thinkingBlocks: string[] = [];
  for (let i = 0, n = Math.floor(next() * 3); i < n; i++) {
    thinkingBlocks.push(words(next, 1 + Math.floor(next() * 40 * scale)));
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
    thinkingBlocks,
    images: [],
    toolCalls,
    filePaths: [],
    artifacts: [],
    exitCode: null,
  };
}
