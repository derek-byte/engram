// Ask answer-quality eval core: a citation-faithfulness judge for `engram ask`.
//
// For each question it runs the REAL ask path (runSearch → grounded LLM call →
// [n] citation resolution), splits the answer into cited claims, and asks a judge
// LLM whether each claim is actually supported by ONLY the chunks it cites (no
// uncited candidates are ever shown to the judge — no leakage). It then reports
// per-question and aggregate faithfulness, not-covered rate, citation density,
// and a token/cost estimate.
//
// READ-ONLY: it calls runAsk directly (never askCommand), so it never writes to
// the demand log / recents, never writes to owner 'derek', and touches the sqlite
// demand_log only through a readonly connection. It builds its embedder with NO
// cache seam, exactly like askCommand, so there are no cache writes either.
//
// This module is the lifted core: `benchmarks/askeval.ts` (a thin CLI wrapper)
// and `engram askeval-run` (the hidden command the UI job runner spawns) both
// drive `runAskEval`.

import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import OpenAI from 'openai';
import { configIsComplete, LOCAL_DB_PATH } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { runAsk, OpenAIAskLLM, askOutcome, type AskResult } from '../ask/index.ts';
import { runSearch } from '../search/index.ts';
import { modelParams } from '../wiki/llm.ts';
import { parseTier } from '../commands/search.ts';
import type { EngramConfig, SearchFilters, SearchResult } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';

export const DEFAULT_QUESTIONS = 'benchmarks/askeval_questions.jsonl';
export const DEFAULT_K = 12; // matches askCommand's default k
const JUDGE_TIMEOUT_MS = 60_000;

// Best-effort $/1M-token list prices for the models this eval tends to use, so
// the cost line is a dollar figure and not just a token count. Unknown models
// report tokens only. Edit this table for your own model/pricing.
const PRICING: Record<string, { in: number; out: number }> = {
  'gpt-5.6-luna': { in: 1, out: 6 },
  'gpt-5.4-mini': { in: 0.75, out: 4.5 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1': { in: 2, out: 8 },
};

export type Verdict = 'supported' | 'partial' | 'unsupported';

export interface Question {
  id: string;
  question: string;
  repo?: string;
  branch?: string;
  tier?: string;
  k?: number;
}

// A maximal answer segment ending in one or more [n] markers, plus the citation
// indices that close it.
export interface Claim {
  text: string;
  indices: number[];
}

export interface JudgedClaim {
  claim: string;
  indices: number[];
  verdict: Verdict;
  reason: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface QuestionReport {
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

export interface AskEvalSummary {
  questions: number;
  answered: number;
  notCovered: number;
  errors: number;
  totalClaims: number;
  supported: number;
  partial: number;
  unsupported: number;
  faithfulnessPct: number;
  partialPct: number;
  notCoveredPct: number;
  citationDensity: number;
  askModel: string;
  judgeModel: string;
  askTokens: Usage;
  judgeTokens: Usage;
  totalTokens: number;
  costUsd: number | null;
}

export interface AskEvalOutput {
  summary: AskEvalSummary;
  reports: QuestionReport[];
}

// What the run needs; all optional so a caller (CLI / command) can pass just the
// flags it parsed. Defaults mirror the original benchmark: file question set,
// judge model falls back to the ask model.
export interface AskEvalOpts {
  questionsPath?: string;
  fromDemandDays?: number;
  limit?: number;
  judgeModel?: string;
}

// Just the slice of the OpenAI SDK the judge touches, so tests inject a fake
// judge without an API key. The real OpenAI client satisfies this shape.
export interface JudgeChatClient {
  chat: {
    completions: {
      create(
        body: {
          model: string;
          response_format: { type: 'json_object' };
          messages: Array<{ role: 'system' | 'user'; content: string }>;
          max_completion_tokens?: number;
          temperature?: number;
        },
        options?: { timeout?: number; maxRetries?: number }
      ): Promise<{
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      }>;
    };
  };
}

// The real collaborators the run drives. Backend/embedder/askLlm mirror how
// askCommand builds them (no cache seam → read-only); judge is a plain chat
// client. defaultJudgeModel is the ask model — the judge falls back to it when
// opts.judgeModel is absent. loadQuestions is a seam so tests can supply a fixed
// question set with no filesystem / sqlite read.
export interface AskEvalDeps {
  backend: VectorBackend;
  embedder: Embedder;
  askLlm: OpenAIAskLLM;
  judge: JudgeChatClient;
  defaultJudgeModel: string;
  loadQuestions?: (opts: AskEvalOpts) => Question[];
}

// Fires once per question, AFTER it completes, so the report is populated. The
// first three params are the documented contract (i, n, questionLabel); the
// optional report lets the streaming command emit outcome/verdict counts per
// question without a second pass. The benchmark ignores the report.
export type ProgressFn = (i: number, n: number, questionLabel: string, report?: QuestionReport) => void;

// Returns the guard message when the eval cannot run (paid, live-backend), else
// null. Both surfaces call this first: the benchmark prints it to stderr + exits,
// the command emits it as an error JSON line.
export function askEvalConfigError(config: EngramConfig): string | null {
  if (!configIsComplete(config) || !config.databaseUrl) {
    return 'askeval: engram is not configured (need a databaseUrl). Run `engram backfill` first.';
  }
  if (!config.openaiApiKey) {
    return 'askeval: needs OPENAI_API_KEY (env or ~/.engram/config.json) — it runs `engram ask` and an LLM judge, both of which call OpenAI. Refusing to run.';
  }
  return null;
}

// Build the real collaborators exactly like the benchmark/askCommand did. Caller
// must guard with askEvalConfigError first. Returns a close() the caller runs in
// finally to release the pg pool.
export async function buildAskEvalDeps(config: EngramConfig): Promise<{ deps: AskEvalDeps; close: () => Promise<void> }> {
  const backend = PgVectorBackend.fromConfig(config);
  await backend.initialize();
  // No cache seam → no writes, exactly like askCommand builds its embedder.
  const embedder = new Embedder(buildProvider(config));
  const askLlm = new OpenAIAskLLM(config.openaiApiKey, config.askModel);
  const judge = new OpenAI({ apiKey: config.openaiApiKey }) as unknown as JudgeChatClient;
  const deps: AskEvalDeps = { backend, embedder, askLlm, judge, defaultJudgeModel: config.wikiModel };
  return { deps, close: () => backend.close() };
}

export function loadQuestionsFromFile(path: string): Question[] {
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
export function loadQuestionsFromDemand(days: number): Question[] {
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

// Resolve the question set from opts: demand replay or the file set, then apply
// --limit. Throws with a clear message on the empty/invalid cases (callers format
// the message for their surface).
export function defaultLoadQuestions(opts: AskEvalOpts): Question[] {
  let questions: Question[];
  if (opts.fromDemandDays !== undefined) {
    if (!Number.isFinite(opts.fromDemandDays) || opts.fromDemandDays <= 0) {
      throw new Error('askeval: --from-demand needs a positive number of days');
    }
    questions = loadQuestionsFromDemand(opts.fromDemandDays);
    if (questions.length === 0) {
      throw new Error(
        `askeval: no distinct answered asks in the demand log over the last ${opts.fromDemandDays} days. Nothing to replay.`
      );
    }
  } else {
    questions = loadQuestionsFromFile(opts.questionsPath ?? DEFAULT_QUESTIONS);
  }
  if (opts.limit !== undefined && Number.isFinite(opts.limit)) questions = questions.slice(0, opts.limit);
  return questions;
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
export async function judgeAnswer(
  client: JudgeChatClient,
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

export function normalizeVerdict(v: string | undefined): Verdict {
  const s = (v ?? '').toLowerCase();
  if (s === 'supported' || s === 'partial' || s === 'unsupported') return s;
  // A missing/garbled verdict is treated as unsupported — the judge failed to
  // vouch for the claim, so it does not count toward faithfulness.
  return 'unsupported';
}

export function priceUsd(model: string, usage: Usage): number | null {
  const p = PRICING[model];
  if (!p) return null;
  return (usage.promptTokens / 1e6) * p.in + (usage.completionTokens / 1e6) * p.out;
}

// Aggregate per-question reports into the summary. Pure, so the roll-up math is
// unit-testable without a live backend.
export function aggregate(
  reports: QuestionReport[],
  askModel: string,
  judgeModel: string,
  askUsage: Usage,
  judgeUsage: Usage
): AskEvalSummary {
  const totalClaims = reports.reduce((a, r) => a + r.claimCount, 0);
  const totalSupported = reports.reduce((a, r) => a + r.supported, 0);
  const totalPartial = reports.reduce((a, r) => a + r.partial, 0);
  const answered = reports.filter((r) => r.outcome === 'answered');
  const notCovered = reports.filter((r) => r.outcome === 'not_covered' || r.outcome === 'no_candidates');
  const errors = reports.filter((r) => r.outcome === 'error');
  const faithfulness = totalClaims === 0 ? 0 : totalSupported / totalClaims;
  const partialRate = totalClaims === 0 ? 0 : totalPartial / totalClaims;
  const notCoveredRate = reports.length === 0 ? 0 : notCovered.length / reports.length;
  const citationDensity =
    answered.length === 0 ? 0 : answered.reduce((a, r) => a + r.citedSources, 0) / answered.length;

  const askCost = priceUsd(askModel, askUsage);
  const judgeCost = priceUsd(judgeModel, judgeUsage);
  const totalTokens =
    askUsage.promptTokens + askUsage.completionTokens + judgeUsage.promptTokens + judgeUsage.completionTokens;
  const costUsd = askCost !== null && judgeCost !== null ? askCost + judgeCost : null;

  return {
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
    askModel,
    judgeModel,
    askTokens: askUsage,
    judgeTokens: judgeUsage,
    totalTokens,
    costUsd: costUsd !== null ? Number(costUsd.toFixed(4)) : null,
  };
}

// The eval core. Resolves the question set, runs the real ask path + judge per
// question, and rolls up the summary. Never touches config, never closes the
// backend (the caller owns lifecycle via buildAskEvalDeps' close()). onProgress
// fires once per question after it completes.
export async function runAskEval(
  opts: AskEvalOpts,
  deps: AskEvalDeps,
  onProgress?: ProgressFn
): Promise<AskEvalOutput> {
  const loadQuestions = deps.loadQuestions ?? defaultLoadQuestions;
  const questions = loadQuestions(opts);

  const askModel = deps.askLlm.model;
  const judgeModel = opts.judgeModel ?? deps.defaultJudgeModel;

  const reports: QuestionReport[] = [];
  const askUsage: Usage = { promptTokens: 0, completionTokens: 0 };
  const judgeUsage: Usage = { promptTokens: 0, completionTokens: 0 };

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    const filters: SearchFilters = {
      repo: q.repo,
      branch: q.branch,
      tier: parseTier(q.tier ?? 'synth'),
      limit: q.k ?? DEFAULT_K,
    };
    const label = `${q.id}: ${q.question}`;

    let report: QuestionReport;
    let result: AskResult;
    let candidates: SearchResult[];
    try {
      // Capture candidates (with full chunk text) via the same retrieval runAsk
      // uses, then run the real ask. runAsk re-runs search internally; pgvector
      // is deterministic for a fixed query vector + filters, but we map cited
      // sources back to text by chunkId (not position), so any drift is safe.
      candidates = await runSearch(q.question, filters, { backend: deps.backend, embedder: deps.embedder });
      result = await runAsk(q.question, filters, { backend: deps.backend, embedder: deps.embedder, llm: deps.askLlm });
    } catch (err) {
      report = {
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
      };
      reports.push(report);
      onProgress?.(qi + 1, questions.length, label, report);
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
    let judgeError: string | undefined;
    if (claims.length > 0) {
      try {
        const j = await judgeAnswer(deps.judge, judgeModel, q.question, claims, chunkText);
        judged = j.verdicts;
        if (j.usage) {
          judgeUsage.promptTokens += j.usage.promptTokens;
          judgeUsage.completionTokens += j.usage.completionTokens;
        }
      } catch (err) {
        // A judge failure leaves the answer's claims unjudged (claimCount 0) but
        // never aborts the run — the same non-fatal stance as the benchmark.
        judgeError = `judge failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    report = {
      id: q.id,
      question: q.question,
      outcome,
      claimCount: judged.length,
      supported: judged.filter((v) => v.verdict === 'supported').length,
      partial: judged.filter((v) => v.verdict === 'partial').length,
      unsupported: judged.filter((v) => v.verdict === 'unsupported').length,
      citedSources,
      judged,
      ...(judgeError ? { error: judgeError } : {}),
    };
    reports.push(report);
    onProgress?.(qi + 1, questions.length, label, report);
  }

  const summary = aggregate(reports, askModel, judgeModel, askUsage, judgeUsage);
  return { summary, reports };
}
