// Ask answer-quality eval: a citation-faithfulness judge for `engram ask`.
//
// MANUAL benchmark, never CI. It needs a live pgvector index + an OpenAI key and
// spends real money (one ask call + one judge call per question), so it is not
// wired into `bun test` and refuses to run when config is incomplete.
//
// For each question it runs the REAL ask path (runSearch → grounded LLM call →
// [n] citation resolution), splits the answer into cited claims, and asks a judge
// LLM whether each claim is actually supported by ONLY the chunks it cites (no
// uncited candidates are ever shown to the judge — no leakage). It then reports
// per-question and aggregate faithfulness, not-covered rate, citation density,
// and a token/cost estimate.
//
//   bun benchmarks/askeval.ts [--questions <path>] [--from-demand <days>]
//                             [--limit N] [--judge-model <model>] [--json]
//
// READ-ONLY: it calls runAsk directly (never askCommand), so it never writes to
// the demand log / recents, never writes to owner 'derek', and touches the sqlite
// demand_log only through a readonly connection.

import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import OpenAI from 'openai';
import { loadConfig, configIsComplete, LOCAL_DB_PATH } from '../src/config/index.ts';
import { PgVectorBackend } from '../src/storage/pgvector.ts';
import { Embedder, buildProvider } from '../src/ingest/embed.ts';
import { CHUNKER_VERSION } from '../src/ingest/chunker.ts';
import { runAsk, OpenAIAskLLM, askOutcome, type AskResult } from '../src/ask/index.ts';
import { runSearch } from '../src/search/index.ts';
import { modelParams } from '../src/wiki/llm.ts';
import { parseTier } from '../src/commands/search.ts';
import type { SearchFilters, SearchResult } from '../src/types/index.ts';

const DEFAULT_QUESTIONS = 'benchmarks/askeval_questions.jsonl';
const DEFAULT_K = 12; // matches askCommand's default k
const JUDGE_TIMEOUT_MS = 60_000;

// Best-effort $/1M-token list prices for the models this eval tends to use, so
// the cost line is a dollar figure and not just a token count. Unknown models
// report tokens only. Edit this table for your own model/pricing.
const PRICING: Record<string, { in: number; out: number }> = {
  'gpt-5.4-mini': { in: 0.75, out: 4.5 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1': { in: 2, out: 8 },
};

type Verdict = 'supported' | 'partial' | 'unsupported';

interface Question {
  id: string;
  question: string;
  repo?: string;
  branch?: string;
  tier?: string;
  k?: number;
}

// A maximal answer segment ending in one or more [n] markers, plus the citation
// indices that close it.
interface Claim {
  text: string;
  indices: number[];
}

interface JudgedClaim {
  claim: string;
  indices: number[];
  verdict: Verdict;
  reason: string;
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
}

interface QuestionReport {
  id: string;
  question: string;
  outcome: ReturnType<typeof askOutcome> | 'error';
  claimCount: number;
  supported: number;
  partial: number;
  unsupported: number;
  citedSources: number; // distinct cited sources for this answer
  judged: JudgedClaim[];
  error?: string;
}

interface Args {
  questionsPath: string;
  fromDemand?: number;
  limit?: number;
  judgeModel?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { questionsPath: DEFAULT_QUESTIONS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--questions') args.questionsPath = argv[++i]!;
    else if (a === '--from-demand') args.fromDemand = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--judge-model') args.judgeModel = argv[++i];
    else if (a === '--json') args.json = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function loadQuestionsFromFile(path: string): Question[] {
  const raw = readFileSync(path, 'utf-8');
  const out: Question[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const o = JSON.parse(t) as Question;
    if (!o.question || typeof o.question !== 'string') {
      throw new Error(`question set line missing "question": ${t.slice(0, 120)}`);
    }
    out.push(o);
  }
  return out;
}

// Replay distinct answered asks from the demand_log directly (LocalStore.unmetDemand
// is the WRONG source — it surfaces UNMET demand). Read-only connection; the demand
// table lives in the same sqlite the CLI/UI write to.
function loadQuestionsFromDemand(days: number): Question[] {
  const db = new Database(LOCAL_DB_PATH, { readonly: true });
  try {
    const rows = db
      .query<{ query: string }, [string]>(
        `SELECT query, MAX(ts) AS latest
           FROM demand_log
          WHERE kind = 'ask' AND outcome = 'answered' AND ts >= datetime('now', ?)
          GROUP BY query
          ORDER BY latest DESC`
      )
      .all(`-${days} days`);
    return rows.map((r, i) => ({ id: `demand-${i + 1}`, question: r.query }));
  } finally {
    db.close();
  }
}

// Split an answer into cited claims: each claim is the maximal run of text ending
// in one or more consecutive [n] markers. Trailing prose that carries no marker
// (e.g. a "the material doesn't cover this" sentence) is intentionally dropped —
// it is not a cited claim and there are no chunks to judge it against.
export function splitClaims(answer: string, maxIndex: number): Claim[] {
  // A marker run: one or more [n] tokens separated only by whitespace.
  const runRe = /(\[\d+\])(?:\s*\[\d+\])*/g;
  const claims: Claim[] = [];
  let cursor = 0;
  for (const m of answer.matchAll(runRe)) {
    const runStart = m.index!;
    const runEnd = runStart + m[0].length;
    const text = answer.slice(cursor, runStart).trim();
    const indices: number[] = [];
    for (const marker of m[0].matchAll(/\[(\d+)\]/g)) {
      const n = Number(marker[1]);
      if (Number.isInteger(n) && n >= 1 && n <= maxIndex && !indices.includes(n)) indices.push(n);
    }
    // Skip empty runs (e.g. two adjacent runs with no prose between them merge).
    if (text.length > 0 && indices.length > 0) claims.push({ text: `${text} ${m[0]}`.trim(), indices });
    cursor = runEnd;
  }
  return claims;
}

// One judge call per ANSWER, batching every claim. Each claim is shown ONLY the
// full text of the chunks it cites — never any uncited candidate.
async function judgeAnswer(
  client: OpenAI,
  model: string,
  question: string,
  claims: Claim[],
  chunkText: Map<number, string>
): Promise<{ verdicts: JudgedClaim[]; usage: Usage | null }> {
  const claimBlocks = claims.map((c, i) => {
    const cited = c.indices
      .map((n) => `--- cited source [${n}] ---\n${chunkText.get(n) ?? '(missing source text)'}`)
      .join('\n\n');
    return `CLAIM ${i + 1}: ${c.text}\n\nSources this claim cites:\n${cited}`;
  });

  const system = `You are a strict citation-faithfulness judge. For each claim you are given the claim text and the FULL text of ONLY the sources it cites. Decide whether the cited sources actually support the claim.

Verdicts:
- "supported": every factual assertion in the claim is directly stated in or entailed by the cited sources.
- "partial": the sources support part of the claim but not all of it, or support it only loosely.
- "unsupported": the cited sources do not support the claim (fabrication, wrong attribution, or contradiction).

Judge ONLY against the provided sources — never outside knowledge. Return STRICT JSON: {"verdicts": [{"claim": <1-based int>, "verdict": "supported"|"partial"|"unsupported", "reason": "<one line>"}]} with exactly one entry per claim.`;

  const user = `Question the answer addresses: ${question}\n\n${claimBlocks.join('\n\n========\n\n')}`;

  const res = await client.chat.completions.create(
    {
      model,
      ...modelParams(model),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    { timeout: JUDGE_TIMEOUT_MS, maxRetries: 1 }
  );

  const content = res.choices[0]?.message?.content ?? '';
  const usage: Usage | null = res.usage
    ? { promptTokens: res.usage.prompt_tokens ?? 0, completionTokens: res.usage.completion_tokens ?? 0 }
    : null;

  let parsed: { verdicts?: Array<{ claim?: number; verdict?: string; reason?: string }> };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`judge returned malformed JSON: ${content.slice(0, 200)}`);
  }
  const byIndex = new Map<number, { verdict?: string; reason?: string }>();
  for (const v of parsed.verdicts ?? []) {
    if (typeof v.claim === 'number') byIndex.set(v.claim, v);
  }

  const verdicts: JudgedClaim[] = claims.map((c, i) => {
    const v = byIndex.get(i + 1);
    const verdict = normalizeVerdict(v?.verdict);
    return { claim: c.text, indices: c.indices, verdict, reason: v?.reason?.trim() || '(no reason given)' };
  });
  return { verdicts, usage };
}

function normalizeVerdict(v: string | undefined): Verdict {
  const s = (v ?? '').toLowerCase();
  if (s === 'supported' || s === 'partial' || s === 'unsupported') return s;
  // A missing/garbled verdict is treated as unsupported — the judge failed to
  // vouch for the claim, so it does not count toward faithfulness.
  return 'unsupported';
}

function priceUsd(model: string, usage: Usage): number | null {
  const p = PRICING[model];
  if (!p) return null;
  return (usage.promptTokens / 1e6) * p.in + (usage.completionTokens / 1e6) * p.out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function printTable(reports: QuestionReport[]): void {
  const cols = [
    ['question', 40],
    ['outcome', 14],
    ['claims', 7],
    ['supp', 5],
    ['part', 5],
    ['unsup', 6],
    ['cited', 6],
  ] as const;
  const line = (cells: string[]) => cells.map((c, i) => pad(c, cols[i]![1])).join(' ');
  console.log('\n' + line(cols.map((c) => c[0])));
  console.log('-'.repeat(cols.reduce((a, c) => a + c[1] + 1, 0)));
  for (const r of reports) {
    console.log(
      line([
        r.question,
        r.outcome,
        String(r.claimCount),
        String(r.supported),
        String(r.partial),
        String(r.unsupported),
        String(r.citedSources),
      ])
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // Refuse clearly when we cannot run: this is a paid, live-backend benchmark.
  if (!configIsComplete(config) || !config.databaseUrl) {
    console.error('askeval: engram is not configured (need a databaseUrl). Run `engram backfill` first.');
    process.exit(1);
  }
  if (!config.openaiApiKey) {
    console.error(
      'askeval: needs OPENAI_API_KEY (env or ~/.engram/config.json) — it runs `engram ask` and an LLM judge, both of which call OpenAI. Refusing to run.'
    );
    process.exit(1);
  }

  const judgeModel = args.judgeModel ?? config.wikiModel;

  let questions: Question[];
  if (args.fromDemand !== undefined) {
    if (!Number.isFinite(args.fromDemand) || args.fromDemand <= 0) {
      console.error('askeval: --from-demand needs a positive number of days');
      process.exit(1);
    }
    questions = loadQuestionsFromDemand(args.fromDemand);
    if (questions.length === 0) {
      console.error(
        `askeval: no distinct answered asks in the demand log over the last ${args.fromDemand} days. Nothing to replay.`
      );
      process.exit(1);
    }
  } else {
    questions = loadQuestionsFromFile(args.questionsPath);
  }
  if (args.limit !== undefined && Number.isFinite(args.limit)) questions = questions.slice(0, args.limit);

  const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION, {
    vectorWeight: config.vectorWeight,
    keywordWeight: config.keywordWeight,
    timeDecayHalfLifeDays: config.timeDecayHalfLifeDays,
  });
  await backend.initialize();
  // No cache seam → no writes, exactly like askCommand builds its embedder.
  const embedder = new Embedder(buildProvider(config));
  const askLlm = new OpenAIAskLLM(config.openaiApiKey, config.wikiModel);
  const judge = new OpenAI({ apiKey: config.openaiApiKey });

  const reports: QuestionReport[] = [];
  let askUsage: Usage = { promptTokens: 0, completionTokens: 0 };
  let judgeUsage: Usage = { promptTokens: 0, completionTokens: 0 };

  try {
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi]!;
      const filters: SearchFilters = {
        repo: q.repo,
        branch: q.branch,
        tier: parseTier(q.tier ?? 'synth'),
        limit: q.k ?? DEFAULT_K,
      };

      console.error(`[${qi + 1}/${questions.length}] ${q.id}: ${q.question}`);

      let result: AskResult;
      let candidates: SearchResult[];
      try {
        // Capture candidates (with full chunk text) via the same retrieval runAsk
        // uses, then run the real ask. runAsk re-runs search internally; pgvector
        // is deterministic for a fixed query vector + filters, but we map cited
        // sources back to text by chunkId (not position), so any drift is safe.
        candidates = await runSearch(q.question, filters, { backend, embedder });
        result = await runAsk(q.question, filters, { backend, embedder, llm: askLlm });
      } catch (err) {
        reports.push({
          id: q.id,
          question: q.question,
          outcome: 'error',
          claimCount: 0,
          supported: 0,
          partial: 0,
          unsupported: 0,
          citedSources: 0,
          judged: [],
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (result.usage) {
        askUsage.promptTokens += result.usage.promptTokens;
        askUsage.completionTokens += result.usage.completionTokens;
      }

      const outcome = askOutcome(result);
      const citedSources = result.sources.filter((s) => s.cited).length;

      // Map citation index n → the full chunk text it points at, via chunkId so
      // the mapping holds even if the two searches ordered candidates differently.
      const contentById = new Map(candidates.map((c) => [c.chunk.id, c.chunk.content]));
      const chunkText = new Map<number, string>();
      for (const s of result.sources) {
        chunkText.set(s.n, contentById.get(s.chunkId) ?? '');
      }

      const claims = result.answer ? splitClaims(result.answer, result.sources.length) : [];

      let judged: JudgedClaim[] = [];
      if (claims.length > 0) {
        try {
          const j = await judgeAnswer(judge, judgeModel, q.question, claims, chunkText);
          judged = j.verdicts;
          if (j.usage) {
            judgeUsage.promptTokens += j.usage.promptTokens;
            judgeUsage.completionTokens += j.usage.completionTokens;
          }
        } catch (err) {
          console.error(`  judge failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      reports.push({
        id: q.id,
        question: q.question,
        outcome,
        claimCount: judged.length,
        supported: judged.filter((v) => v.verdict === 'supported').length,
        partial: judged.filter((v) => v.verdict === 'partial').length,
        unsupported: judged.filter((v) => v.verdict === 'unsupported').length,
        citedSources,
        judged,
      });
    }
  } finally {
    await backend.close();
  }

  // Aggregate.
  const totalClaims = reports.reduce((a, r) => a + r.claimCount, 0);
  const totalSupported = reports.reduce((a, r) => a + r.supported, 0);
  const totalPartial = reports.reduce((a, r) => a + r.partial, 0);
  const answered = reports.filter((r) => r.outcome === 'answered');
  const notCovered = reports.filter((r) => r.outcome === 'not_covered' || r.outcome === 'no_candidates');
  const errors = reports.filter((r) => r.outcome === 'error');
  const faithfulness = totalClaims === 0 ? 0 : totalSupported / totalClaims;
  const partialRate = totalClaims === 0 ? 0 : totalPartial / totalClaims;
  const notCoveredRate = reports.length === 0 ? 0 : notCovered.length / reports.length;
  const citationDensity = answered.length === 0 ? 0 : answered.reduce((a, r) => a + r.citedSources, 0) / answered.length;

  const askCost = priceUsd(config.wikiModel, askUsage);
  const judgeCost = priceUsd(judgeModel, judgeUsage);
  const totalTokens =
    askUsage.promptTokens + askUsage.completionTokens + judgeUsage.promptTokens + judgeUsage.completionTokens;
  const costUsd = askCost !== null && judgeCost !== null ? askCost + judgeCost : null;

  const summary = {
    questions: reports.length,
    answered: answered.length,
    notCovered: notCovered.length,
    errors: errors.length,
    totalClaims,
    supported: totalSupported,
    partial: totalPartial,
    unsupported: totalClaims - totalSupported - totalPartial,
    faithfulnessPct: Number((faithfulness * 100).toFixed(1)),
    partialPct: Number((partialRate * 100).toFixed(1)),
    notCoveredPct: Number((notCoveredRate * 100).toFixed(1)),
    citationDensity: Number(citationDensity.toFixed(2)),
    askModel: config.wikiModel,
    judgeModel,
    askTokens: askUsage,
    judgeTokens: judgeUsage,
    totalTokens,
    costUsd: costUsd !== null ? Number(costUsd.toFixed(4)) : null,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, reports }, null, 2));
    return;
  }

  printTable(reports);

  console.log('\nAggregate');
  console.log('---------');
  console.log(`questions:        ${summary.questions} (answered ${summary.answered}, not-covered ${summary.notCovered}, errors ${summary.errors})`);
  console.log(`cited claims:     ${summary.totalClaims} (supported ${summary.supported}, partial ${summary.partial}, unsupported ${summary.unsupported})`);
  console.log(`faithfulness:     ${summary.faithfulnessPct}% supported  (+${summary.partialPct}% partial)`);
  console.log(`not-covered rate: ${summary.notCoveredPct}%`);
  console.log(`citation density: ${summary.citationDensity} cited sources / answered question`);
  console.log(
    `ask (${summary.askModel}):   ${askUsage.promptTokens} in + ${askUsage.completionTokens} out tok`
  );
  console.log(
    `judge (${judgeModel}): ${judgeUsage.promptTokens} in + ${judgeUsage.completionTokens} out tok`
  );
  const costStr = costUsd !== null ? `$${costUsd.toFixed(4)}` : `${totalTokens} tok (set PRICING for a $ estimate)`;
  console.log(`est. cost:        ${costStr}`);

  // Surface any unsupported/partial claims — the whole point of the eval.
  const flagged = reports.flatMap((r) =>
    r.judged.filter((v) => v.verdict !== 'supported').map((v) => ({ id: r.id, v }))
  );
  if (flagged.length > 0) {
    console.log('\nFlagged claims (partial/unsupported)');
    console.log('------------------------------------');
    for (const { id, v } of flagged) {
      console.log(`[${id}] ${v.verdict.toUpperCase()} ${v.indices.map((n) => `[${n}]`).join('')}: ${v.claim}`);
      console.log(`    ↳ ${v.reason}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
