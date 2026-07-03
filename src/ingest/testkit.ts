import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chunk, EngramConfig, RawEvent, SearchFilters, SearchResult, ToolCall, Trajectory } from '../types/index.ts';
import type { EmbeddingCache, VectorBackend } from '../storage/backend.ts';
import type { EmbeddingProvider, ProviderEmbedding } from './embed.ts';
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

// ---------------------------------------------------------------------------
// In-memory VectorBackend mirroring pgvector's conflict semantics
// ---------------------------------------------------------------------------

export class FakeBackend implements VectorBackend {
  readonly rawEvents = new Map<string, RawEvent>(); // keyed by content_sha256 (unique)
  readonly chunks = new Map<string, Chunk>(); // keyed by id (primary key)
  private cache = new FakeCache();

  insertRawEventsCalls = 0;
  upsertCalls = 0;
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
    }
  }

  async getCachedEmbeddings(shas: string[], model: string): Promise<Map<string, number[]>> {
    return this.cache.getCachedEmbeddings(shas, model);
  }

  async putCachedEmbeddings(entries: Array<{ sha: string; embedding: number[] }>, model: string): Promise<void> {
    return this.cache.putCachedEmbeddings(entries, model);
  }

  async search(queryEmbedding: number[], _queryText: string, filters: SearchFilters): Promise<SearchResult[]> {
    const rows = [...this.chunks.values()].filter((c) => !filters.owner || c.metadata.owner === filters.owner);
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
    return { chunks, rawEvents };
  }

  async close(): Promise<void> {}
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
    exitCode: null,
  };
}
