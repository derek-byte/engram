// Four-arm retrieval A/B: does an LLM contextual prefix (Anthropic's Contextual
// Retrieval, https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide)
// and/or an OpenAI embedder beat local MiniLM on Derek's REAL coding corpus?
//
//   | arm | embedder                        | chunk text                |
//   |-----|---------------------------------|---------------------------|
//   |  A  | local MiniLM all-MiniLM-L6-v2   | v3 chunks as-is           |
//   |  B  | MiniLM                          | prefix + "\n\n" + chunk   |
//   |  C  | OpenAI text-embedding-3-small   | v3 chunks as-is           |
//   |  D  | OpenAI 3-small                  | prefix + "\n\n" + chunk   |
//
// Self-retrieval: query = a trajectory's user turn (first 200 chars, never
// prefixed); ground truth = its trajectoryId. Metrics hit@1/3/5, MRR@10, sliced
// overall / tool-heavy / pure-prose.
//
// SAFETY (hard invariants):
//   1. Never write a row to the live `engram` database. The ONLY statements run
//      against it: pg_database existence probe, CREATE/DROP DATABASE for the two
//      hardcoded bench DBs, and a read-only derek row/tombstone snapshot asserted
//      equal at start and end.
//   2. Chunk ids are salted per arm (chunkHash(`${arm}:${trajId}`, i, text)) but
//      metadata.trajectoryId carries the REAL hash (scoring matches on it).
//   3. Budget guard: projected prefix-gen cost (from cache misses) aborts the run
//      above $6 unless --force.
//   4. Fail-safe prefixes: any LLM failure → embed the raw chunk (arm B/D degrades
//      toward its no-prefix twin, never dies).
//
// Arms C/D are 1536-dim and cannot enter the live vector(384) index, so two
// dedicated bench DBs on the same OrbStack Postgres server carry the full
// production schema: engram_bench_minilm (384, A+B) and engram_bench_openai
// (1536, C+D). The exact shipping hybrid-search SQL runs verbatim per arm.
//
// Usage:
//   bun benchmarks/retrievalab.ts [--arms A,B,C,D] [--limit N] [--max-queries 300]
//     [--skip-ingest] [--no-cleanup] [--force] [--concurrency 8]
//     [--prefix-cache <path>] [--out retrievalab-report.md]
//
// Free local smoke (no OpenAI):
//   bun benchmarks/retrievalab.ts --limit 10 --max-queries 15 --arms A

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import postgres from 'postgres';
import { findJsonl } from '../src/commands/backfill.ts';
import { PgVectorBackend } from '../src/storage/pgvector.ts';
import { Embedder, FastembedProvider, OpenAIProvider } from '../src/ingest/embed.ts';
import { LOCAL_DIM, LOCAL_MODEL, OPENAI_DEFAULT_DIM, OPENAI_DEFAULT_MODEL } from '../src/config/defaults.ts';
import { parseJsonl } from '../src/ingest/parser.ts';
import { chunkMessages, chunkTrajectory } from '../src/ingest/chunker.ts';
import { chunkHash, contentSha256, trajectoryHash } from '../src/ingest/hash.ts';
import { buildTrajectoryContext, resolvePrefixes, type PrefixStats } from '../src/ingest/contextPrefix.ts';
import { rng } from '../src/ingest/testkit.ts';
import type { Chunk, EmbeddedChunk, EngramConfig, Trajectory } from '../src/types/index.ts';
import { JsonlPrefixCache, DEFAULT_PREFIX_CACHE_PATH } from './prefixcache.ts';

// --- Hardcoded constants (SACRED — the DROP DATABASE interpolates ONLY these) --
const LIVE_OWNER = 'derek';
const BENCH_PREFIX = 'bench:';
const MINILM_DB = 'engram_bench_minilm';
const OPENAI_DB = 'engram_bench_openai';
const PREFIX_MODEL = 'gpt-4o-mini';
const K = 10;
const SEED = 42;
const QUERY_CHARS = 200;
const MIN_USER_CHARS = 40;
const BATCH = 64;
const BUDGET_USD = 6; // aborts prefix generation above this unless --force

// gpt-4o-mini pricing (per 1M tokens) + the output-token assumption for the guard.
const MINI_INPUT_PER_M = 0.15;
const MINI_OUTPUT_PER_M = 0.6;
const ASSUMED_OUTPUT_TOKENS = 100;
const PROMPT_SCAFFOLD_CHARS = 320; // the cookbook wrapper around {context}+{chunk}
// text-embedding-3-small pricing (per 1M tokens).
const OPENAI_EMBED_PER_M = 0.02;
const CHARS_PER_TOKEN = 4;

type ArmName = 'A' | 'B' | 'C' | 'D';
type EmbedderKind = 'minilm' | 'openai';

interface ArmSpec {
  db: string;
  dim: number;
  model: string;
  prefix: boolean;
  embedder: EmbedderKind;
}

const ARM_SPEC: Record<ArmName, ArmSpec> = {
  A: { db: MINILM_DB, dim: LOCAL_DIM, model: LOCAL_MODEL, prefix: false, embedder: 'minilm' },
  B: { db: MINILM_DB, dim: LOCAL_DIM, model: LOCAL_MODEL, prefix: true, embedder: 'minilm' },
  C: { db: OPENAI_DB, dim: OPENAI_DEFAULT_DIM, model: OPENAI_DEFAULT_MODEL, prefix: false, embedder: 'openai' },
  D: { db: OPENAI_DB, dim: OPENAI_DEFAULT_DIM, model: OPENAI_DEFAULT_MODEL, prefix: true, embedder: 'openai' },
};

const armOwner = (arm: ArmName): string => `${BENCH_PREFIX}retrievalab:${arm}`;

interface Args {
  arms: ArmName[];
  limit: number | null;
  maxQueries: number;
  skipIngest: boolean;
  cleanup: boolean;
  force: boolean;
  concurrency: number;
  prefixCache: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    arms: ['A', 'B', 'C', 'D'],
    limit: null,
    maxQueries: 300,
    skipIngest: false,
    cleanup: true,
    force: false,
    concurrency: 8,
    prefixCache: DEFAULT_PREFIX_CACHE_PATH,
    out: 'retrievalab-report.md',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--arms') {
      const raw = (argv[++i] ?? '').split(',').map((s) => s.trim().toUpperCase());
      const arms = raw.filter((s): s is ArmName => s === 'A' || s === 'B' || s === 'C' || s === 'D');
      if (arms.length === 0) throw new Error(`--arms must name at least one of A,B,C,D`);
      args.arms = [...new Set(arms)].sort() as ArmName[];
    } else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--max-queries') args.maxQueries = Number(argv[++i]);
    else if (a === '--skip-ingest') args.skipIngest = true;
    else if (a === '--no-cleanup') args.cleanup = false;
    else if (a === '--force') args.force = true;
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--prefix-cache') args.prefixCache = argv[++i]!;
    else if (a === '--out') args.out = argv[++i]!;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function benchConfig(databaseUrl: string, model: string, dim: number): EngramConfig {
  return {
    databaseUrl,
    openaiApiKey: '',
    embeddingProvider: 'local',
    embeddingModel: model,
    embeddingDim: dim,
    watchPath: join(homedir(), '.claude', 'projects'),
    sessionCompleteDelaySec: 0,
    chunkBatchSize: BATCH,
    scoring: {
      vectorWeight: 0.7,
      keywordWeight: 0.3,
      timeDecayHalfLifeDays: 0,
      recencyWeight: 0.1,
      recencyHalfLifeDays: 30,
      importanceWeight: 0.1,
    },
    rerank: { enabled: false, model: 'gpt-4.1-mini', topK: 30 },
    imageCaption: { enabled: false, model: 'gpt-4o-mini', maxPerTrajectory: 4 },
    dreamModel: 'unused',
    dreamMaxInputChars: 200_000,
    wikiDir: join(homedir(), '.engram', 'retrievalab-wiki-unused'),
    wikiModel: 'unused',
    wikiMaxInputChars: 60_000,
    askModel: 'unused',
    synthesis: { enabled: false, hour: 3, targetedSessionsPerNight: 0 },
    contextInjection: { enabled: false, budget: 1500 },
  };
}

// A user turn that is a real question/instruction, not a harness artifact.
function meaningfulUserTurn(t: Trajectory): boolean {
  const u = t.userMessage.trim();
  if (u.length < MIN_USER_CHARS) return false;
  if (u.startsWith('<')) return false; // <command-*>, <local-command-*>, <system-reminder>, <task>…
  if (u.startsWith('Caveat:')) return false;
  if (u.startsWith('[Request interrupted')) return false;
  return true;
}

// --- Scoring (copied verbatim from chunkerab.ts; do NOT refactor that file) ----
interface ArmScore {
  n: number;
  hit1: number;
  hit3: number;
  hit5: number;
  mrrSum: number;
}
function newScore(): ArmScore {
  return { n: 0, hit1: 0, hit3: 0, hit5: 0, mrrSum: 0 };
}
function record(s: ArmScore, rank: number | null): void {
  s.n++;
  if (rank !== null) {
    if (rank === 1) s.hit1++;
    if (rank <= 3) s.hit3++;
    if (rank <= 5) s.hit5++;
    s.mrrSum += 1 / rank;
  }
}
function fmtScore(s: ArmScore): string {
  const pct = (x: number) => (s.n === 0 ? '—' : ((100 * x) / s.n).toFixed(1) + '%');
  const mrr = s.n === 0 ? '—' : (s.mrrSum / s.n).toFixed(3);
  return `${pct(s.hit1)} | ${pct(s.hit3)} | ${pct(s.hit5)} | ${mrr}`;
}

// Lightweight, memory-bounded record held after the Trajectory is dropped.
interface Rec {
  trajectoryId: string;
  chunkTexts: string[];
  context: string;
  query: string; // '' when not a meaningful user turn
  hasTools: boolean;
  meta: {
    repo: string;
    branch: string;
    timestamp: Date;
    filePaths: string[];
    sessionId: string;
    cwd: string;
    exitCode: number | null;
    artifacts: Chunk['metadata']['artifacts'];
  };
}

// Swap the database name in the live URL for a bench DB (name is hardcoded).
function benchUrl(liveUrl: string, dbName: string): string {
  const u = new URL(liveUrl);
  u.pathname = '/' + dbName;
  return u.toString();
}

interface Snapshot {
  rows: string;
  tombstones: string;
}
async function derekSnapshot(sql: ReturnType<typeof postgres>): Promise<Snapshot> {
  const [row] = await sql<Array<{ n: string; t: string }>>`
    SELECT count(*)::text AS n, count(invalid_at)::text AS t
    FROM chunks WHERE owner = ${LIVE_OWNER}
  `;
  return { rows: row?.n ?? '0', tombstones: row?.t ?? '0' };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const timings: Array<[string, number]> = [];
  const mark = (label: string, since: number) => timings.push([label, (Date.now() - since) / 1000]);
  const log = (s: string) => console.log(s);

  const needsPrefix = args.arms.some((a) => ARM_SPEC[a].prefix); // B or D
  const needsOpenAI = args.arms.some((a) => ARM_SPEC[a].embedder === 'openai'); // C or D
  const needsMinilmDb = args.arms.some((a) => ARM_SPEC[a].db === MINILM_DB);
  const needsOpenAIDb = args.arms.some((a) => ARM_SPEC[a].db === OPENAI_DB);
  const needsKey = needsOpenAI || needsPrefix;

  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (needsKey && !apiKey) {
    console.error(
      `OPENAI_API_KEY is empty but arms ${args.arms.join(',')} need it ` +
        `(prefix generation and/or OpenAI embeddings). Set it in .env or run --arms A.`
    );
    process.exitCode = 2;
    return;
  }

  const liveUrl = process.env.ENGRAM_DATABASE_URL ?? 'postgres://engram:engram@localhost:5432/engram';
  const liveSql = postgres(liveUrl, { prepare: false, onnotice: () => {} });

  // Connections + backends opened below; closed in finally before any DROP.
  let minilmSql: ReturnType<typeof postgres> | null = null;
  let openaiSql: ReturnType<typeof postgres> | null = null;
  let minilmBackend: PgVectorBackend | null = null;
  let openaiBackend: PgVectorBackend | null = null;

  const report: string[] = [];
  let startSnap: Snapshot | null = null;

  try {
    // --- Preflight: is Postgres up? Snapshot derek's rows. --------------------
    try {
      startSnap = await derekSnapshot(liveSql);
    } catch (err) {
      console.error(
        `Could not reach Postgres at ${liveUrl}. Is OrbStack (or Docker) running and is the ` +
          `engram Postgres container up? postgres.js surfaces connection failures as a near-empty ` +
          `AggregateError. Original: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exitCode = 2;
      return;
    }
    log(`Live derek snapshot: ${startSnap.rows} chunks, ${startSnap.tombstones} tombstones (must be unchanged at teardown).`);

    // --- Ensure bench DBs exist (CREATE only if absent) -----------------------
    const ensureDb = async (name: string) => {
      const rows = await liveSql<Array<{ one: number }>>`SELECT 1 AS one FROM pg_database WHERE datname = ${name}`;
      if (rows.length === 0) {
        await liveSql.unsafe(`CREATE DATABASE ${name}`);
        log(`Created bench database ${name}.`);
      } else {
        log(`Bench database ${name} already exists — reusing.`);
      }
    };
    if (needsMinilmDb) await ensureDb(MINILM_DB);
    if (needsOpenAIDb) await ensureDb(OPENAI_DB);

    // --- Build per-DB backends + admin connections ----------------------------
    if (needsMinilmDb) {
      const url = benchUrl(liveUrl, MINILM_DB);
      minilmBackend = PgVectorBackend.fromConfig(benchConfig(url, LOCAL_MODEL, LOCAL_DIM));
      await minilmBackend.initialize();
      minilmSql = postgres(url, { prepare: false, onnotice: () => {} });
    }
    if (needsOpenAIDb) {
      const url = benchUrl(liveUrl, OPENAI_DB);
      openaiBackend = PgVectorBackend.fromConfig(benchConfig(url, OPENAI_DEFAULT_MODEL, OPENAI_DEFAULT_DIM));
      await openaiBackend.initialize();
      openaiSql = postgres(url, { prepare: false, onnotice: () => {} });
    }

    const backendFor = (arm: ArmName): PgVectorBackend => {
      const b = ARM_SPEC[arm].db === MINILM_DB ? minilmBackend : openaiBackend;
      if (!b) throw new Error(`no backend for arm ${arm}`);
      return b;
    };
    const sqlFor = (arm: ArmName): ReturnType<typeof postgres> => {
      const s = ARM_SPEC[arm].db === MINILM_DB ? minilmSql : openaiSql;
      if (!s) throw new Error(`no sql connection for arm ${arm}`);
      return s;
    };

    // Embedders (cached in their own bench DB's embedding_cache so re-scoring is
    // cheap). MiniLM is keyless; OpenAI is constructed DIRECTLY (not buildProvider,
    // whose keyless force-latch would silently swap to MiniLM and die at the dim
    // check). Lazily built so an A-only run never touches OpenAI.
    let minilmEmbedder: Embedder | null = null;
    let openaiEmbedder: Embedder | null = null;
    const minilm = (): Embedder => (minilmEmbedder ??= new Embedder(new FastembedProvider(), minilmBackend!));
    const openai = (): Embedder => (openaiEmbedder ??= new Embedder(new OpenAIProvider(apiKey), openaiBackend!));
    const embedderFor = (kind: EmbedderKind): Embedder => (kind === 'minilm' ? minilm() : openai());

    // --- Parse the corpus once into lightweight records -----------------------
    const parseStart = Date.now();
    let files = findJsonl(benchConfig(liveUrl, LOCAL_MODEL, LOCAL_DIM).watchPath);
    log(`Found ${files.length} session file(s) under ~/.claude/projects.`);
    if (args.limit !== null && Number.isFinite(args.limit)) files = files.slice(0, args.limit);
    if (args.limit !== null) log(`--limit ${args.limit}: capped to ${files.length} file(s).`);

    const byId = new Map<string, Rec>();
    let parsedTrajectories = 0;
    for (const f of files) {
      let trajectories: Trajectory[];
      try {
        trajectories = chunkMessages(parseJsonl(f)); // no imageData → no captions, uniform across arms
      } catch {
        continue;
      }
      for (const t of trajectories) {
        parsedTrajectories++;
        const id = trajectoryHash(t);
        if (byId.has(id)) continue; // dedupe by id, first wins
        const meaningful = meaningfulUserTurn(t);
        byId.set(id, {
          trajectoryId: id,
          chunkTexts: chunkTrajectory(t),
          context: buildTrajectoryContext(t),
          query: meaningful ? t.userMessage.replace(/\s+/g, ' ').trim().slice(0, QUERY_CHARS) : '',
          hasTools: t.toolCalls.length > 0,
          meta: {
            repo: t.repo,
            branch: t.branch,
            timestamp: t.timestamp,
            filePaths: t.filePaths,
            sessionId: t.sessionId,
            cwd: t.cwd,
            exitCode: t.exitCode,
            artifacts: t.artifacts,
          },
        });
      }
    }
    const records = [...byId.values()];
    const totalChunks = records.reduce((n, r) => n + r.chunkTexts.length, 0);
    mark('parse', parseStart);
    log(`Parsed ${parsedTrajectories} trajectories (${records.length} distinct, ${totalChunks} v3 chunks).`);

    // --- Prefix pass (shared by B + D) ----------------------------------------
    const prefixCache = new JsonlPrefixCache(args.prefixCache);
    let prefixes = new Map<string, string>();
    let prefixStats: PrefixStats = { cacheHits: 0, generated: 0, fallbacks: 0, promptTokens: 0, completionTokens: 0 };
    let prefixSeconds = 0;
    if (needsPrefix) {
      const prefixStart = Date.now();
      // Unique chunk texts by sha; carry the enclosing trajectory's context.
      const bySha = new Map<string, { sha: string; chunkText: string; context: string }>();
      for (const r of records) {
        for (const text of r.chunkTexts) {
          const sha = contentSha256(text);
          if (!bySha.has(sha)) bySha.set(sha, { sha, chunkText: text, context: r.context });
        }
      }
      const items = [...bySha.values()];

      // Budget guard from actual cache MISSES (tokens ≈ chars/4).
      const cached = await prefixCache.getCachedPrefixes(
        items.map((i) => i.sha),
        PREFIX_MODEL
      );
      const misses = items.filter((i) => !cached.has(i.sha));
      const inputChars = misses.reduce((n, m) => n + m.context.length + m.chunkText.length + PROMPT_SCAFFOLD_CHARS, 0);
      const inputTokens = inputChars / CHARS_PER_TOKEN;
      const projected =
        (inputTokens / 1e6) * MINI_INPUT_PER_M + (misses.length * ASSUMED_OUTPUT_TOKENS / 1e6) * MINI_OUTPUT_PER_M;
      log(
        `Prefix pass: ${items.length} unique chunks, ${cached.size} cached, ${misses.length} to generate. ` +
          `Projected cost $${projected.toFixed(2)} (budget $${BUDGET_USD}).`
      );
      if (projected > BUDGET_USD && !args.force) {
        console.error(
          `ABORT: projected prefix-generation cost $${projected.toFixed(2)} exceeds the $${BUDGET_USD} budget ` +
            `(${misses.length} chunks). Re-run with --force to override, or reduce --limit.`
        );
        process.exitCode = 3;
        return;
      }

      // The OpenAI SDK's chat.completions.create is a superset of PrefixClient.
      const openaiClient = new OpenAI({ apiKey }) as unknown as Parameters<typeof resolvePrefixes>[1]['client'];
      const resolved = await resolvePrefixes(items, {
        cache: prefixCache,
        model: PREFIX_MODEL,
        client: openaiClient,
        concurrency: args.concurrency,
        onProgress: (done, total) => {
          if (done % 200 === 0 || done === total) log(`  prefixes ${done}/${total} generated...`);
        },
      });
      prefixes = resolved.prefixes;
      prefixStats = resolved.stats;
      prefixSeconds = (Date.now() - prefixStart) / 1000;
      log(
        `Prefix pass done: ${prefixStats.cacheHits} cache hits, ${prefixStats.generated} generated, ` +
          `${prefixStats.fallbacks} fallbacks, ${prefixStats.promptTokens}+${prefixStats.completionTokens} tokens.`
      );
    }

    // The embed text for an arm: raw chunk, or prefix + "\n\n" + raw (fallback to
    // raw when the prefix is absent — invariant 4).
    const embedTextFor = (arm: ArmName, rawText: string, sha: string): string => {
      if (!ARM_SPEC[arm].prefix) return rawText;
      const p = prefixes.get(sha);
      return p !== undefined ? `${p}\n\n${rawText}` : rawText;
    };

    // --- Ingest per arm -------------------------------------------------------
    const ingestSeconds = new Map<ArmName, number>();
    const openaiEmbedChars = new Map<ArmName, number>(); // for OpenAI embedding cost
    if (!args.skipIngest) {
      for (const arm of args.arms) {
        const armStart = Date.now();
        const owner = armOwner(arm);
        const backend = backendFor(arm);
        const embedder = embedderFor(ARM_SPEC[arm].embedder);

        // Flatten every chunk of every record into embed units for this arm.
        const units: Array<{ id: string; text: string; rec: Rec; chunkIndex: number; chunkCount: number }> = [];
        for (const r of records) {
          const chunkCount = r.chunkTexts.length;
          r.chunkTexts.forEach((rawText, i) => {
            const sha = contentSha256(rawText);
            const text = embedTextFor(arm, rawText, sha);
            const id = chunkHash(`${arm}:${r.trajectoryId}`, i, text); // salted id (invariant 2)
            units.push({ id, text, rec: r, chunkIndex: i, chunkCount });
          });
        }

        let embedded = 0;
        let chars = 0;
        for (let i = 0; i < units.length; i += BATCH) {
          const batch = units.slice(i, i + BATCH);
          const { embeddings, model } = await embedder.embedWithStats(
            batch.map((b) => b.text),
            batch.map((b) => `${b.rec.trajectoryId} (${b.id})`)
          );
          for (const b of batch) chars += b.text.length;
          const chunks: EmbeddedChunk[] = batch.map((b, idx) => ({
            id: b.id,
            embedding: embeddings[idx]!,
            content: b.text,
            metadata: {
              repo: b.rec.meta.repo,
              branch: b.rec.meta.branch,
              timestamp: b.rec.meta.timestamp,
              filePaths: b.rec.meta.filePaths,
              artifacts: b.rec.meta.artifacts,
              exitCode: b.rec.meta.exitCode,
              sessionId: b.rec.meta.sessionId,
              cwd: b.rec.meta.cwd,
              owner,
              tier: 'raw',
              trajectoryId: b.rec.trajectoryId, // REAL hash (invariant 2)
              chunkIndex: b.chunkIndex,
              chunkCount: b.chunkCount,
              embeddingModel: model,
            },
          }));
          await backend.upsert(chunks);
          embedded += chunks.length;
          if (embedded % (BATCH * 25) === 0) log(`  [${arm}] embedded ${embedded}/${units.length}...`);
        }
        if (ARM_SPEC[arm].embedder === 'openai') openaiEmbedChars.set(arm, chars);
        ingestSeconds.set(arm, (Date.now() - armStart) / 1000);
        log(`Arm ${arm}: ingested ${embedded} chunks into ${ARM_SPEC[arm].db} (owner ${owner}), ${((Date.now() - armStart) / 1000).toFixed(0)}s.`);
      }
    } else {
      log('--skip-ingest: reusing existing bench chunks.');
    }

    // --- Coverage: trajectoryIds present in ALL selected arms -----------------
    const coverage = new Map<ArmName, Set<string>>();
    for (const arm of args.arms) {
      const rows = await sqlFor(arm)<Array<{ trajectory_id: string }>>`
        SELECT DISTINCT trajectory_id FROM chunks
        WHERE owner = ${armOwner(arm)} AND tier = 'raw' AND trajectory_id IS NOT NULL
      `;
      coverage.set(arm, new Set(rows.map((r) => r.trajectory_id)));
    }
    let intersection = new Set<string>();
    args.arms.forEach((arm, idx) => {
      const s = coverage.get(arm)!;
      intersection = idx === 0 ? new Set(s) : new Set([...intersection].filter((id) => s.has(id)));
    });
    log(
      `Coverage: ` +
        args.arms.map((a) => `${a}=${coverage.get(a)!.size}`).join(', ') +
        `, intersection=${intersection.size}.`
    );

    // --- Query set ------------------------------------------------------------
    const candidates = records.filter((r) => r.query !== '' && intersection.has(r.trajectoryId));
    const nextRand = rng(SEED);
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(nextRand() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }
    const queries = Number.isFinite(args.maxQueries) ? candidates.slice(0, args.maxQueries) : candidates;
    const nTools = queries.filter((q) => q.hasTools).length;
    log(`Query set: ${queries.length} self-retrieval queries (${nTools} tool-heavy, ${queries.length - nTools} pure prose).`);

    // --- Score ----------------------------------------------------------------
    const scoreStart = Date.now();
    const scores = {} as Record<ArmName, { all: ArmScore; tool: ArmScore; prose: ArmScore }>;
    for (const arm of args.arms) scores[arm] = { all: newScore(), tool: newScore(), prose: newScore() };

    let done = 0;
    for (const q of queries) {
      // Query embedding per embedding model (never prefixed).
      const vecCache = new Map<EmbedderKind, number[]>();
      const vecFor = async (kind: EmbedderKind): Promise<number[]> => {
        let v = vecCache.get(kind);
        if (!v) {
          v = await embedderFor(kind).embedOne(q.query);
          vecCache.set(kind, v);
        }
        return v;
      };
      for (const arm of args.arms) {
        const vec = await vecFor(ARM_SPEC[arm].embedder);
        const results = await backendFor(arm).search(vec, q.query, {
          tier: 'raw',
          limit: K,
          owner: armOwner(arm),
          exhaustive: true,
        });
        let rank: number | null = null;
        for (let i = 0; i < results.length; i++) {
          if (results[i]!.chunk.metadata.trajectoryId === q.trajectoryId) {
            rank = i + 1;
            break;
          }
        }
        const bucket = q.hasTools ? 'tool' : 'prose';
        record(scores[arm].all, rank);
        record(scores[arm][bucket], rank);
      }
      done++;
      if (done % 50 === 0) log(`  scored ${done}/${queries.length}...`);
    }
    mark('score', scoreStart);

    // --- Descriptive stats per arm --------------------------------------------
    interface StatRow {
      chunks: string;
      trajs: string;
      avg_len: string;
      p50: string;
      p90: string;
      max_len: string;
      chunks_per_traj: string;
    }
    const armStats = new Map<ArmName, StatRow>();
    for (const arm of args.arms) {
      const [row] = await sqlFor(arm)<StatRow[]>`
        SELECT
          count(*)::text AS chunks,
          count(DISTINCT trajectory_id)::text AS trajs,
          round(avg(length(content)))::text AS avg_len,
          round(percentile_cont(0.5) WITHIN GROUP (ORDER BY length(content)))::text AS p50,
          round(percentile_cont(0.9) WITHIN GROUP (ORDER BY length(content)))::text AS p90,
          max(length(content))::text AS max_len,
          round(count(*)::numeric / NULLIF(count(DISTINCT trajectory_id), 0), 2)::text AS chunks_per_traj
        FROM chunks WHERE owner = ${armOwner(arm)} AND tier = 'raw'
      `;
      if (row) armStats.set(arm, row);
    }

    // --- Sample (prefix, chunk-first-120) pairs for eyeballing ----------------
    const samples: Array<{ prefix: string; chunkHead: string }> = [];
    if (needsPrefix) {
      const nextSample = rng(SEED + 1);
      const withPrefix: Array<{ text: string; sha: string }> = [];
      for (const r of records) {
        for (const text of r.chunkTexts) {
          const sha = contentSha256(text);
          if (prefixes.has(sha)) withPrefix.push({ text, sha });
        }
      }
      for (let i = withPrefix.length - 1; i > 0; i--) {
        const j = Math.floor(nextSample() * (i + 1));
        [withPrefix[i], withPrefix[j]] = [withPrefix[j]!, withPrefix[i]!];
      }
      for (const s of withPrefix.slice(0, 5)) {
        samples.push({ prefix: prefixes.get(s.sha)!, chunkHead: s.text.replace(/\s+/g, ' ').slice(0, 120) });
      }
    }

    // --- Report ---------------------------------------------------------------
    const openaiCostFor = (arm: ArmName): number => ((openaiEmbedChars.get(arm) ?? 0) / CHARS_PER_TOKEN / 1e6) * OPENAI_EMBED_PER_M;
    const prefixCost =
      (prefixStats.promptTokens / 1e6) * MINI_INPUT_PER_M + (prefixStats.completionTokens / 1e6) * MINI_OUTPUT_PER_M;

    report.push(`## Four-arm retrieval A/B (embedding × contextual-prefix)`);
    report.push('');
    report.push(`- Arms: ${args.arms.join(', ')}.`);
    report.push(`- Corpus: ${files.length} session files, ${records.length} distinct trajectories, ${totalChunks} v3 chunks.`);
    report.push(`- Coverage: ` + args.arms.map((a) => `${a}=${coverage.get(a)!.size}`).join(', ') + `; scored the ${intersection.size} in the intersection (${queries.length} sampled, seed ${SEED}).`);
    report.push(`- Search: tier=raw, k=${K}, hybrid 0.7 vector / 0.3 keyword, exhaustive (exact cosine), no rerank — the exact shipping SQL, per bench DB.`);
    report.push(`- Embedders: MiniLM ${LOCAL_MODEL} (${LOCAL_DIM}d) for A/B; OpenAI ${OPENAI_DEFAULT_MODEL} (${OPENAI_DEFAULT_DIM}d) for C/D. Queries are never prefixed.`);
    report.push('');
    report.push(`### Self-retrieval (query = user turn, truth = its trajectory)`);
    report.push('');
    report.push(`| slice | arm | n | hit@1 | hit@3 | hit@5 | MRR@10 |`);
    report.push(`|---|---|---|---|---|---|---|`);
    for (const slice of ['all', 'tool', 'prose'] as const) {
      const label = slice === 'all' ? 'overall' : slice === 'tool' ? 'tool-heavy' : 'pure prose';
      for (const arm of args.arms) {
        const s = scores[arm][slice];
        report.push(`| ${label} | ${arm} | ${s.n} | ${fmtScore(s)} |`);
      }
    }
    report.push('');
    report.push(`### Chunk size/count distribution (raw tier)`);
    report.push('');
    report.push(`| arm | chunks | trajectories | chunks/traj | avg chars | p50 | p90 | max |`);
    report.push(`|---|---|---|---|---|---|---|---|`);
    for (const arm of args.arms) {
      const r = armStats.get(arm);
      if (r) report.push(`| ${arm} | ${r.chunks} | ${r.trajs} | ${r.chunks_per_traj} | ${r.avg_len} | ${r.p50} | ${r.p90} | ${r.max_len} |`);
    }
    report.push('');
    report.push(`### Prefix generation (shared by arms B + D)`);
    report.push('');
    if (needsPrefix) {
      const meanLen = prefixes.size > 0 ? Math.round([...prefixes.values()].reduce((n, p) => n + p.length, 0) / prefixes.size) : 0;
      report.push(`- Generator: ${PREFIX_MODEL}. Cache: \`${args.prefixCache}\`.`);
      report.push(`- Cache hits: ${prefixStats.cacheHits}; generated: ${prefixStats.generated}; fallbacks (LLM failure → raw chunk): ${prefixStats.fallbacks}.`);
      report.push(`- Mean prefix length: ${meanLen} chars; tokens ${prefixStats.promptTokens} in / ${prefixStats.completionTokens} out.`);
    } else {
      report.push(`- No prefix arm selected.`);
    }
    report.push('');
    report.push(`### Cost`);
    report.push('');
    report.push(`- Prefix generation (attributed jointly to B+D): $${prefixCost.toFixed(4)}.`);
    for (const arm of args.arms) {
      if (ARM_SPEC[arm].embedder === 'openai') report.push(`- OpenAI embeddings, arm ${arm}: $${openaiCostFor(arm).toFixed(4)}.`);
    }
    report.push('');
    report.push(`### Wall time`);
    report.push('');
    for (const [label, secs] of timings) report.push(`- ${label}: ${secs.toFixed(1)}s.`);
    if (needsPrefix) report.push(`- prefix: ${prefixSeconds.toFixed(1)}s.`);
    for (const arm of args.arms) if (ingestSeconds.has(arm)) report.push(`- ingest ${arm}: ${ingestSeconds.get(arm)!.toFixed(1)}s.`);
    report.push(`- total: ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    report.push('');
    if (samples.length > 0) {
      report.push(`### Sampled prefixes (eyeball quality)`);
      report.push('');
      for (const s of samples) {
        report.push(`- **prefix:** ${s.prefix}`);
        report.push(`  **chunk:** ${s.chunkHead}…`);
      }
      report.push('');
    }
    report.push(`### Interpretation — arm B (MiniLM + prefix)`);
    report.push('');
    report.push(
      `v3 chunks target 350 tokens, but MiniLM (all-MiniLM-L6-v2) has a ~256-token attention window. A 50–100-token ` +
        `situating prefix therefore displaces an equal amount of chunk tail OUT of the window, so arm B can score at or ` +
        `below arm A — an informative negative (the window is saturated), not a bug. The contrast to watch is (B−A) vs ` +
        `(D−C): OpenAI 3-small has an 8k-token window, so if the prefix helps retrieval at all, D−C isolates that gain ` +
        `free of the window effect that suppresses B−A.`
    );

    const md = report.join('\n');
    writeFileSync(args.out, md);
    console.log('\n' + md);
    log(`\nReport written to ${args.out}`);
  } finally {
    // --- Cleanup --------------------------------------------------------------
    // Close every bench connection BEFORE DROP (DROP … WITH FORCE also terminates
    // stragglers, but our own handles must go first).
    await minilmBackend?.close().catch(() => {});
    await openaiBackend?.close().catch(() => {});
    await minilmSql?.end().catch(() => {});
    await openaiSql?.end().catch(() => {});

    try {
      if (args.cleanup) {
        // DROP interpolates ONLY the two hardcoded constants — never args/config.
        for (const name of [MINILM_DB, OPENAI_DB]) {
          await liveSql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
          const [row] = await liveSql<Array<{ one: number }>>`SELECT 1 AS one FROM pg_database WHERE datname = ${name}`;
          if (row) {
            console.error(`WARNING: bench database ${name} still exists after DROP!`);
            process.exitCode = 1;
          }
        }
        console.log(`Cleanup: dropped ${MINILM_DB} + ${OPENAI_DB}.`);
      } else {
        console.log(`--no-cleanup: bench databases kept (${MINILM_DB}, ${OPENAI_DB}). Re-run with --skip-ingest to re-score.`);
      }

      // Derek must be untouched by US. The airtight guarantee is that every
      // harness write stamps owner 'bench:%' (the tripwire below), so a change to
      // derek's rows is never ours. The snapshot is the secondary check — but the
      // Engram desktop app may be ingesting derek's active session concurrently
      // during a multi-minute run, which legitimately GROWS the row count. So: a
      // pure count increase with unchanged tombstones is benign concurrent live
      // ingestion (noted, not failed); a tombstone change or a row DECREASE cannot
      // come from append-only live ingest and stays a hard failure.
      if (startSnap) {
        const endSnap = await derekSnapshot(liveSql);
        const rowDelta = Number(endSnap.rows) - Number(startSnap.rows);
        const tombDelta = Number(endSnap.tombstones) - Number(startSnap.tombstones);
        if (rowDelta < 0 || tombDelta !== 0) {
          console.error(
            `WARNING: derek snapshot changed in a way live ingestion cannot explain! ` +
              `start=${JSON.stringify(startSnap)} end=${JSON.stringify(endSnap)} (rowDelta=${rowDelta}, tombDelta=${tombDelta})`
          );
          process.exitCode = 1;
        } else if (rowDelta > 0) {
          console.log(
            `Derek snapshot grew by ${rowDelta} chunk(s), tombstones unchanged — concurrent live ingestion by the ` +
              `Engram app (harness writes only 'bench:%' rows; see the zero-bench-rows tripwire below).`
          );
        } else {
          console.log(`Derek snapshot unchanged: ${endSnap.rows} chunks, ${endSnap.tombstones} tombstones.`);
        }
      }
      const [tripwire] = await liveSql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM chunks WHERE owner LIKE ${BENCH_PREFIX + '%'}
      `;
      if (tripwire && tripwire.n !== '0') {
        console.error(`WARNING: ${tripwire.n} bench rows found in the LIVE database — invariant 1 violated!`);
        process.exitCode = 1;
      }
    } finally {
      await liveSql.end().catch(() => {});
    }
  }
}

await main();
