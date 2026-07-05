import { afterEach, describe, expect, test } from 'bun:test';
import { askevalRunCommand, type AskevalRunDeps } from './askevalRun.ts';
import type { LocalStore } from '../storage/local.ts';
import type { AskEvalDeps, AskEvalOutput, QuestionReport } from '../eval/askeval.ts';
import type { EngramConfig } from '../types/index.ts';

const goodConfig = { databaseUrl: 'postgres://x', openaiApiKey: 'sk-x', embeddingProvider: 'openai' } as EngramConfig;

// Records the run-row lifecycle so tests can assert what was persisted.
class FakeStore {
  started = 0;
  finished: Array<{ id: number; status: string; summary?: unknown; reports?: unknown }> = [];
  closed = false;
  startAskevalRun(): number {
    this.started++;
    return 42;
  }
  finishAskevalRun(id: number, status: string, summary?: unknown, reports?: unknown): void {
    this.finished.push({ id, status, summary, reports });
  }
  close(): void {
    this.closed = true;
  }
}

function report(over: Partial<QuestionReport> = {}): QuestionReport {
  return {
    id: 'q1',
    question: 'q?',
    outcome: 'answered',
    claimCount: 1,
    supported: 1,
    partial: 0,
    unsupported: 0,
    citedSources: 1,
    judged: [],
    ...over,
  };
}

let closeCalled = false;
function baseDeps(store: FakeStore, run: AskevalRunDeps['run']): { deps: AskevalRunDeps; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  closeCalled = false;
  return {
    lines,
    deps: {
      config: goodConfig,
      local: store as unknown as LocalStore,
      build: async () => ({
        deps: {} as AskEvalDeps,
        close: async () => {
          closeCalled = true;
        },
      }),
      run,
      log: (phase, data) => lines.push({ phase, ...data }),
    },
  };
}

const savedExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe('askevalRunCommand', () => {
  test('happy path: opens a run, streams a question line per question, finishes done, closes', async () => {
    const store = new FakeStore();
    const out: AskEvalOutput = {
      summary: { questions: 1, answered: 1 } as AskEvalOutput['summary'],
      reports: [report()],
    };
    const run: AskevalRunDeps['run'] = async (_opts, _deps, onProgress) => {
      onProgress?.(1, 1, 'q1: q?', report());
      return out;
    };
    const { deps, lines } = baseDeps(store, run);

    await askevalRunCommand({}, deps);

    expect(store.started).toBe(1);
    expect(store.finished).toEqual([{ id: 42, status: 'done', summary: out.summary, reports: out.reports }]);
    // An injected local store is owned by the caller — the command never closes it.
    expect(store.closed).toBe(false);
    expect(closeCalled).toBe(true); // the backend pool is always released

    const question = lines.find((l) => l.phase === 'question');
    expect(question).toEqual({ phase: 'question', i: 1, of: 1, label: 'q1: q?', outcome: 'answered', supported: 1, partial: 0, unsupported: 0 });
    const done = lines.find((l) => l.phase === 'done');
    expect(done).toEqual({ phase: 'done', summary: out.summary });
    expect(process.exitCode).toBeFalsy();
  });

  test('run failure marks the row error, logs error, sets exit code, still closes', async () => {
    const store = new FakeStore();
    const run: AskevalRunDeps['run'] = async () => {
      throw new Error('backend exploded');
    };
    const { deps, lines } = baseDeps(store, run);

    await askevalRunCommand({}, deps);

    expect(store.started).toBe(1);
    expect(store.finished).toEqual([{ id: 42, status: 'error', summary: { error: 'backend exploded' }, reports: undefined }]);
    expect(closeCalled).toBe(true);
    expect(store.closed).toBe(false);
    expect(lines.find((l) => l.phase === 'error')).toEqual({ phase: 'error', message: 'backend exploded' });
    expect(process.exitCode).toBe(1);
  });
});
