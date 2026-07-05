import { describe, expect, test } from 'bun:test';
import {
  splitClaims,
  normalizeVerdict,
  priceUsd,
  aggregate,
  runAskEval,
  askEvalConfigError,
  type AskEvalDeps,
  type JudgeChatClient,
  type Question,
  type QuestionReport,
  type Usage,
} from './askeval.ts';
import { OpenAIAskLLM, type AskChatClient } from '../ask/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';
import type { EngramConfig, SearchResult } from '../types/index.ts';

// --- pure helpers ------------------------------------------------------------

describe('splitClaims', () => {
  test('one claim per marker run, prose captured, index resolved', () => {
    const claims = splitClaims('The sky is blue [1]. Grass is green [2].', 2);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toEqual({ text: 'The sky is blue [1]', indices: [1] });
    expect(claims[1]).toEqual({ text: '. Grass is green [2]', indices: [2] });
  });

  test('consecutive markers merge into one claim with de-duped indices', () => {
    const claims = splitClaims('Fact [1] [2] [1].', 2);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.indices).toEqual([1, 2]);
  });

  test('drops out-of-range indices and trailing uncited prose', () => {
    const claims = splitClaims('Good [1]. Bogus [9]. The material does not cover this.', 3);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.indices).toEqual([1]);
  });

  test('answer with no markers yields no claims', () => {
    expect(splitClaims('Nothing is cited here.', 3)).toEqual([]);
  });
});

describe('normalizeVerdict', () => {
  test('passes valid verdicts through (case-insensitive)', () => {
    expect(normalizeVerdict('SUPPORTED')).toBe('supported');
    expect(normalizeVerdict('Partial')).toBe('partial');
    expect(normalizeVerdict('unsupported')).toBe('unsupported');
  });

  test('missing / garbled verdict defaults to unsupported', () => {
    expect(normalizeVerdict(undefined)).toBe('unsupported');
    expect(normalizeVerdict('maybe')).toBe('unsupported');
  });
});

describe('priceUsd', () => {
  test('known model: in + out at list price', () => {
    // gpt-4o-mini: 0.15 in / 0.6 out per 1M
    expect(priceUsd('gpt-4o-mini', { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeCloseTo(0.75, 6);
  });

  test('unknown model returns null (tokens only)', () => {
    expect(priceUsd('mystery-model', { promptTokens: 10, completionTokens: 10 })).toBeNull();
  });
});

describe('aggregate', () => {
  const rep = (over: Partial<QuestionReport>): QuestionReport => ({
    id: 'q',
    question: 'q?',
    outcome: 'answered',
    claimCount: 0,
    supported: 0,
    partial: 0,
    unsupported: 0,
    citedSources: 0,
    judged: [],
    ...over,
  });
  const zero: Usage = { promptTokens: 0, completionTokens: 0 };

  test('rolls up faithfulness, not-covered rate, and citation density', () => {
    const reports = [
      rep({ outcome: 'answered', claimCount: 4, supported: 3, partial: 1, unsupported: 0, citedSources: 2 }),
      rep({ outcome: 'not_covered' }),
      rep({ outcome: 'error' }),
    ];
    const s = aggregate(reports, 'gpt-4o-mini', 'gpt-4o-mini', zero, zero);
    expect(s.questions).toBe(3);
    expect(s.answered).toBe(1);
    expect(s.notCovered).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.totalClaims).toBe(4);
    expect(s.supported).toBe(3);
    expect(s.faithfulnessPct).toBe(75);
    expect(s.partialPct).toBe(25);
    expect(s.notCoveredPct).toBeCloseTo(33.3, 1);
    expect(s.citationDensity).toBe(2); // 2 cited sources / 1 answered question
    expect(s.costUsd).toBe(0); // known models, zero usage
  });

  test('empty run does not divide by zero; unknown model → null cost', () => {
    const s = aggregate([], 'mystery', 'mystery', zero, zero);
    expect(s.faithfulnessPct).toBe(0);
    expect(s.notCoveredPct).toBe(0);
    expect(s.citationDensity).toBe(0);
    expect(s.costUsd).toBeNull();
  });
});

describe('askEvalConfigError', () => {
  const cfg = (over: Partial<EngramConfig>): EngramConfig =>
    ({
      databaseUrl: 'postgres://x',
      openaiApiKey: 'sk-x',
      embeddingModel: 'text-embedding-3-small',
      embeddingDim: 1536,
      ...over,
    }) as EngramConfig;

  test('refuses without a database url', () => {
    expect(askEvalConfigError(cfg({ databaseUrl: '' }))).toContain('not configured');
  });

  test('refuses without an OpenAI key (even when otherwise complete via local embeddings)', () => {
    // embeddingProvider 'local' makes configIsComplete pass keyless, so the guard
    // reaches its own OPENAI_API_KEY branch — the eval still needs a key for the
    // ask + judge LLM calls.
    expect(askEvalConfigError(cfg({ openaiApiKey: '', embeddingProvider: 'local' }))).toContain('OPENAI_API_KEY');
  });

  test('passes when configured', () => {
    expect(askEvalConfigError(cfg({}))).toBeNull();
  });
});

// --- runAskEval orchestration (fakes only, no network) -----------------------

function searchResult(id: string, content: string): SearchResult {
  return {
    chunk: {
      id,
      embedding: [],
      content,
      metadata: {
        repo: 'r',
        branch: 'b',
        timestamp: new Date('2026-01-01T00:00:00Z'),
        filePaths: [],
        exitCode: null,
        sessionId: 's',
        cwd: '/',
        tier: 'wiki',
        trajectoryId: 'wiki:concept',
      },
    },
    similarity: 0.9,
    keywordRank: 0,
    combined: 0.9,
  };
}

// A backend whose search always returns the same two candidates; enough for
// runSearch → runAsk to resolve citations by chunk id.
function fakeBackend(): VectorBackend {
  return {
    search: async () => [searchResult('c1', 'The sky is blue.'), searchResult('c2', 'Grass is green.')],
  } as unknown as VectorBackend;
}

function fakeEmbedder(): Embedder {
  return { embedOne: async () => [0.1, 0.2, 0.3] } as unknown as Embedder;
}

// An ask client that returns a fixed grounded answer citing [1].
function fakeAskLlm(answer = 'The sky is blue [1].'): OpenAIAskLLM {
  const client: AskChatClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: answer } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      },
    },
  };
  return new OpenAIAskLLM('sk-test', 'gpt-4o-mini', client);
}

// A judge that marks every claim supported.
function fakeJudge(verdict: 'supported' | 'partial' | 'unsupported' = 'supported'): JudgeChatClient {
  return {
    chat: {
      completions: {
        create: async (body) => {
          const n = (body.messages[1]!.content.match(/CLAIM \d+:/g) ?? []).length;
          const verdicts = Array.from({ length: n }, (_, i) => ({ claim: i + 1, verdict, reason: 'ok' }));
          return {
            choices: [{ message: { content: JSON.stringify({ verdicts }) } }],
            usage: { prompt_tokens: 50, completion_tokens: 10 },
          };
        },
      },
    },
  };
}

function deps(over: Partial<AskEvalDeps> = {}): AskEvalDeps {
  return {
    backend: fakeBackend(),
    embedder: fakeEmbedder(),
    askLlm: fakeAskLlm(),
    judge: fakeJudge(),
    defaultJudgeModel: 'gpt-4o-mini',
    loadQuestions: () => [{ id: 'q1', question: 'why is the sky blue?' }],
    ...over,
  };
}

describe('runAskEval', () => {
  test('runs the ask path + judge, aggregates, and fires onProgress per question', async () => {
    const questions: Question[] = [
      { id: 'q1', question: 'why is the sky blue?' },
      { id: 'q2', question: 'why is grass green?' },
    ];
    const progress: Array<{ i: number; n: number; label: string; outcome: string | undefined }> = [];
    const { summary, reports } = await runAskEval(
      {},
      deps({ loadQuestions: () => questions }),
      (i, n, label, report) => progress.push({ i, n, label, outcome: report?.outcome })
    );

    expect(reports).toHaveLength(2);
    expect(reports[0]!.outcome).toBe('answered');
    expect(reports[0]!.claimCount).toBe(1);
    expect(reports[0]!.supported).toBe(1);
    expect(reports[0]!.citedSources).toBe(1);

    expect(summary.questions).toBe(2);
    expect(summary.answered).toBe(2);
    expect(summary.faithfulnessPct).toBe(100);
    expect(summary.askModel).toBe('gpt-4o-mini');
    expect(summary.judgeModel).toBe('gpt-4o-mini');
    // ask usage summed across both questions (100/20 each).
    expect(summary.askTokens).toEqual({ promptTokens: 200, completionTokens: 40 });

    expect(progress).toEqual([
      { i: 1, n: 2, label: 'q1: why is the sky blue?', outcome: 'answered' },
      { i: 2, n: 2, label: 'q2: why is grass green?', outcome: 'answered' },
    ]);
  });

  test('opts.judgeModel overrides the default judge model', async () => {
    const { summary } = await runAskEval({ judgeModel: 'gpt-4o' }, deps());
    expect(summary.judgeModel).toBe('gpt-4o');
  });

  test('answer that cites nothing is not_covered and unjudged', async () => {
    const { summary, reports } = await runAskEval({}, deps({ askLlm: fakeAskLlm('The material does not cover this.') }));
    expect(reports[0]!.outcome).toBe('not_covered');
    expect(reports[0]!.claimCount).toBe(0);
    expect(summary.notCovered).toBe(1);
    expect(summary.answered).toBe(0);
  });

  test('a thrown ask records an error report but does not abort the run', async () => {
    const askLlm = fakeAskLlm();
    // Force the ask call to throw.
    (askLlm as unknown as { answer: () => Promise<never> }).answer = async () => {
      throw new Error('boom');
    };
    const { summary, reports } = await runAskEval({}, deps({ askLlm }));
    expect(reports[0]!.outcome).toBe('error');
    expect(reports[0]!.error).toContain('boom');
    expect(summary.errors).toBe(1);
  });

  test('a judge failure leaves the answer unjudged but non-fatal', async () => {
    const judge: JudgeChatClient = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('judge down');
          },
        },
      },
    };
    const { reports } = await runAskEval({}, deps({ judge }));
    expect(reports[0]!.outcome).toBe('answered');
    expect(reports[0]!.claimCount).toBe(0);
    expect(reports[0]!.error).toContain('judge failed');
  });
});
