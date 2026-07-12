// Real-corpus chunker A/B: does chunker v2 (role-homogeneous packing) retrieve
// better than the live v1 index on Derek's REAL tool-heavy trajectories?
// LongMemEval can't answer this — its sessions have no tool calls.
//
// Protocol (free, deterministic, labeled):
//   1. Discover session files exactly like backfill (~/.claude/projects/**.jsonl).
//   2. Build a v2 index with the REAL pipeline (parseJsonl → chunkMessages →
//      chunkTrajectory → embed → upsert) under owner BENCH_OWNER, scratch
//      ENGRAM_LOCAL_DB, into the live pg. The live 'derek' rows are READ-ONLY.
//   3. Guard: the live v1 raw index must be local-MiniLM — the bench index and
//      the query embedder use the SAME model, or the comparison is confounded.
//      If the live index is not local-MiniLM the script STOPs (no OpenAI spend).
//   4. Self-retrieval: query = a trajectory's user turn (first ~200 chars);
//      ground truth = its trajectoryId. Each query runs twice with identical
//      embedder + search params (tier raw, k=10, exhaustive) against owner
//      'derek' (v1) and BENCH_OWNER (v2). Scoring is restricted to
//      trajectoryIds present in BOTH indexes (coverage confound check).
//   5. Metrics: hit@1/3/5, MRR@10; breakdown by tool-segment vs pure-prose
//      trajectories; plus chunk count/size distributions from pg.
//   6. Side-by-side top-3 for real logged queries (LocalStore demand/recents),
//      dumped verbatim for eyeball judgment. No LLM judge.
//   7. Cleanup: delete all BENCH_OWNER rows, verify zero remain.
//
// Usage:
//   bun benchmarks/chunkerab.ts [--max-queries 300] [--skip-ingest] [--no-cleanup]
//     [--demand-db <sqlite copy>] [--out <report.md>]
//
// SAFETY: every write goes under owner 'bench:*'. This script never mutates
// 'derek' rows (raw_events inserts are ON CONFLICT DO NOTHING and chunk ids are
// owner-disjoint because upsert content hashes collide only on identical text —
// on collision the shared row keeps owner 'derek' untouched).

import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { findJsonl } from '../src/commands/backfill.ts';
import { PgVectorBackend } from '../src/storage/pgvector.ts';
import { LocalStore } from '../src/storage/local.ts';
import { Embedder, FastembedProvider } from '../src/ingest/embed.ts';
import { LOCAL_DIM, LOCAL_MODEL } from '../src/config/defaults.ts';
import { ingestFile, type PipelineDeps } from '../src/ingest/pipeline.ts';
import { parseJsonl } from '../src/ingest/parser.ts';
import { chunkMessages } from '../src/ingest/chunker.ts';
import { trajectoryHash } from '../src/ingest/hash.ts';
import { rng } from '../src/ingest/testkit.ts';
import type { EngramConfig, Trajectory } from '../src/types/index.ts';

const LIVE_OWNER = 'derek';
const BENCH_OWNER = 'bench:chunkerab';
const BENCH_PREFIX = 'bench:';
const K = 10;
const QUERY_CHARS = 200;
const MIN_USER_CHARS = 40;
const SEED = 42;

interface Args {
  maxQueries: number;
  skipIngest: boolean;
  cleanup: boolean;
  demandDb: string | null;
  out: string;
  localDb: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    maxQueries: 300,
    skipIngest: false,
    cleanup: true,
    demandDb: null,
    out: 'chunkerab-report.md',
    // Stable path so a killed/re-run ingest resumes via seen_hashes instead of
    // re-embedding the whole corpus.
    localDb: join(tmpdir(), 'chunkerab-local.sqlite'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--max-queries') args.maxQueries = Number(argv[++i]);
    else if (a === '--skip-ingest') args.skipIngest = true;
    else if (a === '--no-cleanup') args.cleanup = false;
    else if (a === '--demand-db') args.demandDb = argv[++i]!;
    else if (a === '--out') args.out = argv[++i]!;
    else if (a === '--local-db') args.localDb = argv[++i]!;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function benchConfig(databaseUrl: string): EngramConfig {
  return {
    databaseUrl,
    openaiApiKey: '',
    embeddingProvider: 'local',
    embeddingModel: LOCAL_MODEL,
    embeddingDim: LOCAL_DIM,
    watchPath: join(homedir(), '.claude', 'projects'),
    sessionCompleteDelaySec: 0,
    chunkBatchSize: 64,
    vectorWeight: 0.7,
    keywordWeight: 0.3,
    timeDecayHalfLifeDays: 0,
    recencyWeight: 0.1,
    recencyHalfLifeDays: 30,
    importanceWeight: 0.1,
    rerank: { enabled: false, model: 'gpt-4.1-mini', topK: 30 },
    imageCaption: { enabled: false, model: 'gpt-4o-mini', maxPerTrajectory: 4 },
    dreamModel: 'unused',
    dreamMaxInputChars: 200_000,
    wikiDir: join(tmpdir(), 'chunkerab-wiki-unused'),
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

interface QueryCase {
  trajectoryId: string;
  query: string;
  hasTools: boolean;
}

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.ENGRAM_DATABASE_URL ?? 'postgres://engram:engram@localhost:5432/engram';
  const config = benchConfig(databaseUrl);
  const sql = postgres(databaseUrl, { prepare: false, onnotice: () => {} });
  const backend = PgVectorBackend.fromConfig(config);
  const report: string[] = [];
  const log = (s: string) => console.log(s);

  try {
    // --- Guard: live index must be local-MiniLM (same model, or STOP) --------
    const liveModels = await sql<Array<{ embedding_model: string | null; n: string }>>`
      SELECT embedding_model, count(*)::text AS n FROM chunks
      WHERE owner = ${LIVE_OWNER} AND tier = 'raw' GROUP BY 1
    `;
    const [dim] = await sql<Array<{ atttypmod: number }>>`
      SELECT atttypmod FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'
    `;
    if (liveModels.length !== 1 || liveModels[0]!.embedding_model !== LOCAL_MODEL || dim?.atttypmod !== LOCAL_DIM) {
      console.error(
        `STOP: live '${LIVE_OWNER}' raw index is not uniformly ${LOCAL_MODEL}/${LOCAL_DIM}: ` +
          JSON.stringify(liveModels) +
          ` dim=${dim?.atttypmod}. A same-model comparison is impossible without OpenAI spend.`
      );
      process.exitCode = 2;
      return;
    }
    log(`Live index: ${liveModels[0]!.n} raw chunks, ${LOCAL_MODEL} (${LOCAL_DIM}d) — same-model A/B is free.`);

    const provider = new FastembedProvider();
    // No cache: query + bench embeddings must leave zero non-bench rows in pg.
    const embedder = new Embedder(provider);

    // --- Discover + parse sessions -------------------------------------------
    const files = findJsonl(config.watchPath);
    log(`Found ${files.length} session file(s) under ${config.watchPath}.`);

    const byId = new Map<string, QueryCase>();
    let parsedTrajectories = 0;
    for (const f of files) {
      let trajectories: Trajectory[];
      try {
        trajectories = chunkMessages(parseJsonl(f));
      } catch {
        continue;
      }
      for (const t of trajectories) {
        parsedTrajectories++;
        const id = trajectoryHash(t);
        if (byId.has(id)) continue;
        byId.set(id, {
          trajectoryId: id,
          query: t.userMessage.replace(/\s+/g, ' ').trim().slice(0, QUERY_CHARS),
          hasTools: t.toolCalls.length > 0,
        });
        if (!meaningfulUserTurn(t)) byId.get(id)!.query = '';
      }
    }
    log(`Parsed ${parsedTrajectories} trajectories (${byId.size} distinct).`);

    // --- Build the v2 bench index --------------------------------------------
    if (!args.skipIngest) {
      await backend.initialize();
      const local = new LocalStore(args.localDb);
      const deps: PipelineDeps = { backend, embedder, local, config, owner: BENCH_OWNER };
      let embedded = 0;
      let errors = 0;
      const t0 = Date.now();
      for (let i = 0; i < files.length; i++) {
        try {
          const r = await ingestFile(files[i]!, deps);
          embedded += r.embedded;
        } catch (err) {
          errors++;
          log(`  ingest error [${files[i]!.split('/').pop()}]: ${err instanceof Error ? err.message : err}`);
        }
        if ((i + 1) % 50 === 0) log(`  ingested ${i + 1}/${files.length} files (${embedded} chunks)...`);
      }
      local.close();
      log(`Bench index built: ${embedded} v2 chunks embedded, ${errors} file error(s), ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
    } else {
      log('Skipping ingest (--skip-ingest): reusing existing bench index.');
    }

    // --- Coverage: trajectoryIds present in BOTH indexes ---------------------
    const trajIdsOf = async (owner: string): Promise<Set<string>> => {
      const rows = await sql<Array<{ trajectory_id: string }>>`
        SELECT DISTINCT trajectory_id FROM chunks
        WHERE owner = ${owner} AND tier = 'raw' AND trajectory_id IS NOT NULL
      `;
      return new Set(rows.map((r) => r.trajectory_id));
    };
    const liveIds = await trajIdsOf(LIVE_OWNER);
    const benchIds = await trajIdsOf(BENCH_OWNER);
    const both = new Set([...liveIds].filter((id) => benchIds.has(id)));
    log(`Coverage: live=${liveIds.size} traj, bench=${benchIds.size} traj, both=${both.size}.`);

    // --- Query set ------------------------------------------------------------
    const candidates = [...byId.values()].filter((c) => c.query !== '' && both.has(c.trajectoryId));
    // Deterministic shuffle (mulberry32) then cap.
    const next = rng(SEED);
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }
    const queries = candidates.slice(0, args.maxQueries);
    const nTools = queries.filter((q) => q.hasTools).length;
    log(`Query set: ${queries.length} self-retrieval queries (${nTools} with tool segments, ${queries.length - nTools} pure prose).`);

    // --- Run the A/B -----------------------------------------------------------
    const arms = { v1: LIVE_OWNER, v2: BENCH_OWNER } as const;
    const scores: Record<string, Record<'all' | 'tool' | 'prose', ArmScore>> = {
      v1: { all: newScore(), tool: newScore(), prose: newScore() },
      v2: { all: newScore(), tool: newScore(), prose: newScore() },
    };
    let done = 0;
    for (const q of queries) {
      const vec = await embedder.embedOne(q.query);
      for (const [armName, owner] of Object.entries(arms)) {
        const results = await backend.search(vec, q.query, {
          tier: 'raw',
          limit: K,
          owner,
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
        record(scores[armName]!.all, rank);
        record(scores[armName]![bucket], rank);
      }
      done++;
      if (done % 50 === 0) log(`  scored ${done}/${queries.length} queries...`);
    }

    // --- Descriptive stats ------------------------------------------------------
    const stats = await sql<
      Array<{
        owner: string;
        chunks: string;
        trajs: string;
        avg_len: string;
        p50: string;
        p90: string;
        max_len: string;
        chunks_per_traj: string;
      }>
    >`
      SELECT owner,
             count(*)::text AS chunks,
             count(DISTINCT trajectory_id)::text AS trajs,
             round(avg(length(content)))::text AS avg_len,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY length(content)))::text AS p50,
             round(percentile_cont(0.9) WITHIN GROUP (ORDER BY length(content)))::text AS p90,
             max(length(content))::text AS max_len,
             round(count(*)::numeric / NULLIF(count(DISTINCT trajectory_id), 0), 2)::text AS chunks_per_traj
      FROM chunks
      WHERE owner IN (${LIVE_OWNER}, ${BENCH_OWNER}) AND tier = 'raw'
      GROUP BY owner ORDER BY owner
    `;

    // --- Report -----------------------------------------------------------------
    report.push(`## Chunker A/B on the real corpus (v1 live vs v2 bench)`);
    report.push('');
    report.push(`- Corpus: ${files.length} session files, ${byId.size} distinct trajectories parsed.`);
    report.push(`- Embedder (index + queries): ${LOCAL_MODEL} (${LOCAL_DIM}d), identical for both arms.`);
    report.push(
      `- Coverage: v1=${liveIds.size} trajectoryIds, v2=${benchIds.size}; scored only the ${both.size} in BOTH (${queries.length} sampled queries, seed ${SEED}).`
    );
    report.push(`- Search: tier=raw, k=${K}, hybrid 0.7 vector / 0.3 keyword, exhaustive (exact cosine), no rerank.`);
    report.push('');
    report.push(`### Self-retrieval (query = user turn, truth = its trajectory)`);
    report.push('');
    report.push(`| slice | arm | n | hit@1 | hit@3 | hit@5 | MRR@10 |`);
    report.push(`|---|---|---|---|---|---|---|`);
    for (const slice of ['all', 'tool', 'prose'] as const) {
      for (const arm of ['v1', 'v2'] as const) {
        const s = scores[arm]![slice];
        const label = slice === 'all' ? 'overall' : slice === 'tool' ? 'with tool segments' : 'pure prose';
        report.push(`| ${label} | ${arm} | ${s.n} | ${fmtScore(s)} |`);
      }
    }
    report.push('');
    report.push(`### Chunk size/count distribution (raw tier)`);
    report.push('');
    report.push(`| arm | chunks | trajectories | chunks/traj | avg chars | p50 | p90 | max |`);
    report.push(`|---|---|---|---|---|---|---|---|`);
    for (const r of stats) {
      const arm = r.owner === LIVE_OWNER ? 'v1 (derek)' : 'v2 (bench)';
      report.push(
        `| ${arm} | ${r.chunks} | ${r.trajs} | ${r.chunks_per_traj} | ${r.avg_len} | ${r.p50} | ${r.p90} | ${r.max_len} |`
      );
    }
    report.push('');

    // --- Real demand queries, side by side ---------------------------------------
    report.push(`### Real logged queries, top-3 side by side`);
    report.push('');
    const demandQueries = readDemandQueries(args.demandDb);
    if (demandQueries.length === 0) {
      report.push(`_No usable demand queries found in the local store._`);
    }
    for (const dq of demandQueries) {
      const vec = await embedder.embedOne(dq);
      report.push(`#### Query: \`${dq}\``);
      for (const [armName, owner] of Object.entries(arms)) {
        const results = await backend.search(vec, dq, { tier: 'raw', limit: 3, owner, exhaustive: true });
        report.push('');
        report.push(`**${armName}** (${owner}):`);
        results.forEach((r, i) => {
          const one = r.chunk.content.replace(/\s+/g, ' ').slice(0, 260);
          report.push(
            `${i + 1}. [sim ${r.similarity.toFixed(3)} | ${r.chunk.metadata.repo || '?'} | ${new Date(r.chunk.metadata.timestamp).toISOString().slice(0, 10)}] ${one}`
          );
        });
      }
      report.push('');
    }

    const md = report.join('\n');
    writeFileSync(args.out, md);
    console.log('\n' + md);
    log(`\nReport written to ${args.out}`);
  } finally {
    // --- Cleanup: no bench rows may remain ---------------------------------------
    if (args.cleanup) {
      const del = await backend.deleteByOwnerPrefix(BENCH_PREFIX);
      const [left] = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM chunks WHERE owner LIKE ${BENCH_PREFIX + '%'}
      `;
      const [leftRaw] = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM raw_events WHERE owner LIKE ${BENCH_PREFIX + '%'}
      `;
      log(
        `Cleanup: deleted ${del.chunks} bench chunks + ${del.rawEvents} bench raw events; remaining bench rows: chunks=${left?.n}, raw_events=${leftRaw?.n}.`
      );
      if (left?.n !== '0' || leftRaw?.n !== '0') {
        console.error('WARNING: bench rows remain after cleanup!');
        process.exitCode = 1;
      }
    } else {
      log(`--no-cleanup: bench rows kept under owner ${BENCH_OWNER}.`);
    }
    await backend.close();
    await sql.end();
  }
}

// Real logged queries from a READ-ONLY copy of ~/.engram/engram.sqlite: prefer
// demand_log; if it is empty (it currently is), fall back to distinct recents
// 'search' keys — real queries Derek typed into the UI. Dedupe case-insensitively
// and drop search-as-you-type prefixes of a longer retained query.
function readDemandQueries(dbPath: string | null): string[] {
  if (!dbPath) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const demand = db
      .query<{ query: string }, []>(
        "SELECT DISTINCT query FROM demand_log WHERE length(query) >= 3 ORDER BY ts DESC LIMIT 20"
      )
      .all()
      .map((r) => r.query);
    const recents = db
      .query<{ key: string }, []>(
        "SELECT DISTINCT key FROM recents WHERE kind = 'search' AND length(key) >= 3 ORDER BY timestamp DESC LIMIT 30"
      )
      .all()
      .map((r) => r.key);
    const pool = demand.length > 0 ? demand : recents;
    const kept: string[] = [];
    for (const q of pool.map((s) => s.trim()).filter(Boolean)) {
      const lower = q.toLowerCase();
      if (kept.some((k) => k.toLowerCase() === lower || k.toLowerCase().startsWith(lower))) continue;
      kept.push(q);
    }
    return kept.slice(0, 20);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

await main();
