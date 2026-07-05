import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Embedder } from './embed.ts';
import { FakeBackend, FakeProvider, tempStore, testConfig, type TempStore } from './testkit.ts';
import type { IngestResult, PipelineDeps } from './pipeline.ts';

const EMPTY: IngestResult = {
  trajectories: 0,
  embedded: 0,
  skipped: 0,
  cacheHits: 0,
  cacheMisses: 0,
  sessionId: '',
  repo: '',
};

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await Bun.sleep(5);
  }
}

describe('SessionWatcher V9b: change during flight is not dropped', () => {
  let ts: TempStore;
  afterEach(() => {
    ts?.cleanup();
    mock.restore();
  });

  test('a second change arriving mid-ingest runs after the first resolves', async () => {
    let ingestCalls = 0;
    let releaseFirst: (() => void) | undefined;

    // Fake the pipeline: the first ingest blocks until we release it; fileIsStable
    // is always true so process() proceeds straight to ingest.
    mock.module('./pipeline.ts', () => ({
      fileIsStable: () => true,
      ingestFile: async (): Promise<IngestResult> => {
        ingestCalls++;
        if (ingestCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return EMPTY;
      },
    }));

    const { SessionWatcher } = await import('./watcher.ts');
    ts = tempStore();
    const backend = new FakeBackend();
    const deps: PipelineDeps = {
      backend,
      embedder: new Embedder(new FakeProvider(), backend),
      local: ts.store,
      config: testConfig(),
    };
    const watcher = new SessionWatcher(deps) as unknown as {
      process(path: string, idleMs: number): Promise<void>;
    };

    const path = '/tmp/session.jsonl';
    const idleMs = 5;

    // First ingest starts and blocks in-flight.
    const p1 = watcher.process(path, idleMs);
    await waitFor(() => ingestCalls === 1);

    // A change arrives while the first ingest is still running: must reschedule,
    // not drop.
    await watcher.process(path, idleMs);
    expect(ingestCalls).toBe(1); // second did not run yet

    // First ingest finishes; the rescheduled run then fires.
    releaseFirst!();
    await p1;
    await waitFor(() => ingestCalls === 2);
    expect(ingestCalls).toBe(2);
  });
});
