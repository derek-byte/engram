import { afterEach, describe, expect, test } from 'bun:test';
import { Embedder } from '../ingest/embed.ts';
import { SynthesisQueue, type SynthesisQueueDeps } from './synthesisQueue.ts';
import { FakeBackend, FakeProvider, testConfig } from '../ingest/testkit.ts';
import type { Lock } from './lock.ts';

const QUIESCENCE = 50;

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await Bun.sleep(10);
  }
}

// A queue whose compile body + lock + stability check are all faked, so tests
// assert the scheduling contract without LLMs, files, or the real lock.
function makeQueue(over: Partial<SynthesisQueueDeps> = {}) {
  const compiled: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const releases = { count: 0 };

  const backend = new FakeBackend();
  const deps: SynthesisQueueDeps = {
    backend,
    embedder: new Embedder(new FakeProvider(), backend),
    config: testConfig(),
    owner: 'derek',
    quiescenceMs: QUIESCENCE,
    acquireLock: (): Lock | null => ({
      release() {
        releases.count++;
      },
    }),
    compile: async (sessionId) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Bun.sleep(15);
      compiled.push(sessionId);
      concurrent--;
    },
    stillIngesting: () => false,
    ...over,
  };
  const queue = new SynthesisQueue(deps);
  return { queue, compiled, releases, get maxConcurrent() {
    return maxConcurrent;
  } };
}

describe('SynthesisQueue quiescence gating', () => {
  const queues: SynthesisQueue[] = [];
  afterEach(() => {
    for (const q of queues.splice(0)) q.stop();
  });

  test('N rapid enqueues → exactly ONE compile after the last + quiescence', async () => {
    const { queue, compiled } = makeQueue();
    queues.push(queue);
    for (let i = 0; i < 5; i++) queue.enqueue('sess-A', 'engram', '/tmp/a.jsonl');

    await Bun.sleep(QUIESCENCE + 40);
    await waitFor(() => compiled.length >= 1);
    // Give any erroneous extra timers a chance to fire.
    await Bun.sleep(QUIESCENCE + 40);
    expect(compiled).toEqual(['sess-A']);
  });

  test('fresh mtime at fire defers, then compiles once ingest settles', async () => {
    let calls = 0;
    const { queue, compiled } = makeQueue({
      // Active on the first fire, settled thereafter → deferred then runs.
      stillIngesting: () => {
        calls++;
        return calls === 1;
      },
    });
    queues.push(queue);
    queue.enqueue('sess-A', 'engram', '/tmp/a.jsonl');

    await waitFor(() => compiled.length === 1);
    expect(compiled).toEqual(['sess-A']);
    expect(calls).toBeGreaterThanOrEqual(2); // deferred at least once
  });

  test('two sessions both compile, never overlapping (serialized)', async () => {
    const h = makeQueue();
    queues.push(h.queue);
    h.queue.enqueue('sess-A', 'engram', '/tmp/a.jsonl');
    h.queue.enqueue('sess-B', 'engram', '/tmp/b.jsonl');

    await waitFor(() => h.compiled.length === 2);
    expect(h.compiled.sort()).toEqual(['sess-A', 'sess-B']);
    expect(h.maxConcurrent).toBe(1); // never ran two compiles at once
  });

  test('lock held at fire → re-enqueued, compiles after the lock releases', async () => {
    let held = true;
    const { queue, compiled } = makeQueue({
      acquireLock: (): Lock | null => (held ? null : { release() {} }),
    });
    queues.push(queue);
    queue.enqueue('sess-A', 'engram', '/tmp/a.jsonl');

    // While held, it keeps deferring — no compile.
    await Bun.sleep(QUIESCENCE + 40);
    expect(compiled.length).toBe(0);

    held = false;
    await waitFor(() => compiled.length === 1);
    expect(compiled).toEqual(['sess-A']);
  });
});
