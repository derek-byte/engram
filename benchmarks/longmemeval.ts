import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { loadConfig } from '../src/config/index.ts';
import { PgVectorBackend } from '../src/storage/pgvector.ts';
import { Embedder, MAX_CHARS_PER_INPUT } from '../src/ingest/embed.ts';
import { CHUNKER_VERSION } from '../src/ingest/chunker.ts';

interface Turn {
  role: string;
  content: string;
}

interface Entry {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_sessions: Turn[][];
  haystack_session_ids: string[];
  haystack_dates: string[];
}

interface QuestionResult {
  question_id: string;
  question_type: string;
  num_sessions: number;
  recall_at: Record<number, number>;
  ndcg_at_10: number;
}

const KS = [1, 3, 5, 10];
const DOC_BATCH = 64;
const CHAR_BUDGET = 150_000;
const N_RESULTS = 50;
const OUTPUT_PATH = 'benchmarks/results_engram_raw.jsonl';
const DEFAULT_DATASET = 'benchmarks/longmemeval_s_cleaned.json';
const PRICE_PER_MILLION_TOKENS = 0.02;

function dcg(relevances: number[], k: number): number {
  let score = 0;
  for (let i = 0; i < Math.min(k, relevances.length); i++) {
    score += relevances[i]! / Math.log2(i + 2);
  }
  return score;
}

function ndcg(rankings: number[], correctIds: Set<string>, corpusIds: string[], k: number): number {
  const relevances = rankings.slice(0, k).map((idx) => (correctIds.has(corpusIds[idx]!) ? 1 : 0));
  const ideal = [...relevances].sort((a, b) => b - a);
  const idcg = dcg(ideal, k);
  if (idcg === 0) return 0;
  return dcg(relevances, k) / idcg;
}

function recallAny(rankings: number[], correctIds: Set<string>, corpusIds: string[], k: number): number {
  const topK = new Set(rankings.slice(0, k).map((idx) => corpusIds[idx]!));
  for (const cid of correctIds) if (topK.has(cid)) return 1;
  return 0;
}

function buildCorpus(entry: Entry): { docs: string[]; ids: string[] } {
  const docs: string[] = [];
  const ids: string[] = [];
  entry.haystack_sessions.forEach((session, i) => {
    const userTurns = session.filter((t) => t.role === 'user').map((t) => t.content);
    if (userTurns.length === 0) return;
    docs.push(userTurns.join('\n').slice(0, MAX_CHARS_PER_INPUT));
    ids.push(entry.haystack_session_ids[i]!);
  });
  return { docs, ids };
}

async function embedCorpus(
  embedder: Embedder,
  docs: string[]
): Promise<{ vectors: number[][]; hits: number; misses: number }> {
  const vectors: number[][] = [];
  let hits = 0;
  let misses = 0;

  let batch: string[] = [];
  let batchChars = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const res = await embedder.embedWithStats(batch);
    vectors.push(...res.embeddings);
    hits += res.cacheHits;
    misses += res.cacheMisses;
    batch = [];
    batchChars = 0;
  };

  for (const doc of docs) {
    if (batch.length >= DOC_BATCH || batchChars + doc.length > CHAR_BUDGET) await flush();
    batch.push(doc);
    batchChars += doc.length;
  }
  await flush();

  return { vectors, hits, misses };
}

function rankByCosine(queryVec: number[], docVecs: number[][]): number[] {
  const scores = docVecs.map((v, idx) => {
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i]! * queryVec[i]!;
    return { idx, dot };
  });
  scores.sort((a, b) => b.dot - a.dot);
  return scores.map((s) => s.idx);
}

function parseArgs(argv: string[]): { dataset: string; limit?: number } {
  let dataset = DEFAULT_DATASET;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--limit') limit = Number(argv[++i]);
    else if (a === '--dataset') dataset = argv[++i]!;
    else if (!a.startsWith('--')) dataset = a;
  }
  return { dataset, limit };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printSummary(results: QuestionResult[]): void {
  const header = ['question_type', 'n', ...KS.map((k) => `R@${k}`), 'NDCG@10'];
  const widths = [26, 5, 8, 8, 8, 8, 9];

  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join('');
  console.log('\n' + line(header));
  console.log('-'.repeat(widths.reduce((a, b) => a + b, 0)));

  const byType = new Map<string, QuestionResult[]>();
  for (const r of results) {
    if (!byType.has(r.question_type)) byType.set(r.question_type, []);
    byType.get(r.question_type)!.push(r);
  }

  const row = (label: string, rs: QuestionResult[]) => {
    const cells = [
      label,
      String(rs.length),
      ...KS.map((k) => mean(rs.map((r) => r.recall_at[k]!)).toFixed(4)),
      mean(rs.map((r) => r.ndcg_at_10)).toFixed(4),
    ];
    console.log(line(cells));
  };

  for (const t of [...byType.keys()].sort()) row(t, byType.get(t)!);
  console.log('-'.repeat(widths.reduce((a, b) => a + b, 0)));
  row('OVERALL', results);
}

async function main(): Promise<void> {
  const { dataset, limit } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!config.openaiApiKey || !config.databaseUrl) {
    console.error('missing OPENAI_API_KEY or ENGRAM_DATABASE_URL (config.json or env)');
    process.exit(1);
  }

  const raw = readFileSync(dataset, 'utf-8');
  let entries: Entry[] = JSON.parse(raw);
  if (limit !== undefined) entries = entries.slice(0, limit);

  const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION);
  await backend.initialize();
  const embedder = new Embedder(config.openaiApiKey, config.embeddingModel, backend);

  writeFileSync(OUTPUT_PATH, '');
  const results: QuestionResult[] = [];
  let totalHits = 0;
  let totalMisses = 0;
  let totalEmbedItems = 0;
  let totalEmbedChars = 0;
  const started = Date.now();

  try {
    for (let qi = 0; qi < entries.length; qi++) {
      const entry = entries[qi]!;
      const { docs, ids } = buildCorpus(entry);
      const correctIds = new Set(entry.answer_session_ids);

      const recallAt: Record<number, number> = {};
      let ndcgAt10 = 0;

      if (docs.length > 0) {
        const { vectors, hits, misses } = await embedCorpus(embedder, docs);
        const qRes = await embedder.embedWithStats([entry.question.slice(0, MAX_CHARS_PER_INPUT)]);
        totalHits += hits + qRes.cacheHits;
        totalMisses += misses + qRes.cacheMisses;
        totalEmbedItems += docs.length + 1;
        totalEmbedChars += docs.reduce((a, d) => a + d.length, 0) + entry.question.length;

        const rankings = rankByCosine(qRes.embeddings[0]!, vectors).slice(0, N_RESULTS);
        const seen = new Set(rankings);
        for (let i = 0; i < docs.length; i++) if (!seen.has(i)) rankings.push(i);

        for (const k of KS) recallAt[k] = recallAny(rankings, correctIds, ids, k);
        ndcgAt10 = ndcg(rankings, correctIds, ids, 10);
      } else {
        for (const k of KS) recallAt[k] = 0;
      }

      const result: QuestionResult = {
        question_id: entry.question_id,
        question_type: entry.question_type,
        num_sessions: docs.length,
        recall_at: recallAt,
        ndcg_at_10: ndcgAt10,
      };
      results.push(result);
      appendFileSync(OUTPUT_PATH, JSON.stringify(result) + '\n');

      if ((qi + 1) % 10 === 0 || qi === entries.length - 1) {
        const rate = mean(results.map((r) => r.recall_at[5]!));
        console.error(
          `[${qi + 1}/${entries.length}] R@5=${rate.toFixed(3)} cache hits=${totalHits} misses=${totalMisses}`
        );
      }
    }
  } finally {
    await backend.close();
  }

  printSummary(results);

  const avgCharsPerItem = totalEmbedItems === 0 ? 0 : totalEmbedChars / totalEmbedItems;
  const estTokens = (totalMisses * avgCharsPerItem) / 4;
  const estCost = (estTokens / 1_000_000) * PRICE_PER_MILLION_TOKENS;
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `\ncache: ${totalHits} hits, ${totalMisses} misses | est. embed cost this run: $${estCost.toFixed(4)} (${Math.round(estTokens).toLocaleString()} tok on misses) | ${elapsed}s`
  );
  console.log(`per-question results: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
