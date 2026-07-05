import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  synthesisRunCommand,
  selectTargetedSessions,
  type SynthesisCollaborators,
  type SynthesisRunDeps,
} from './synthesisRun.ts';
import { loadConfig } from '../config/index.ts';
import { LocalStore, type DemandRow, type UnmetDemandRow } from '../storage/local.ts';
import type { SynthesizeParams, SynthesizeResult } from '../dream/synthesize.ts';
import type { WikiIngestResult } from '../wiki/ingest.ts';
import type { Finding } from '../wiki/lint.ts';
import type { EngramConfig } from '../types/index.ts';

function synthResult(over: Partial<SynthesizeResult> = {}): SynthesizeResult {
  return {
    synthesized: 0,
    dreamChunks: 0,
    emptyUnits: 0,
    skipped: 0,
    deferred: 0,
    failed: 0,
    promptTokens: 0,
    completionTokens: 0,
    dryRun: false,
    ...over,
  };
}

function wikiResult(over: Partial<WikiIngestResult> = {}): WikiIngestResult {
  return {
    unitsCompiled: 0,
    pagesCreated: 0,
    pagesUpdated: 0,
    pagesSkippedGuard: 0,
    pagesRetried: 0,
    pagesAddendum: 0,
    pagesAutolinked: 0,
    unitsSkipped: 0,
    deferred: 0,
    failed: 0,
    promptTokens: 0,
    completionTokens: 0,
    dryRun: false,
    ...over,
  };
}

// A search row that reads as unmet (weak match below UNMET_THRESHOLD) but carries
// real raw coverage (top_session_id) — the exact shape targeted compilation acts on.
function weakSearch(query: string, topSessionId: string): DemandRow {
  return {
    surface: 'ui',
    kind: 'search',
    query,
    tier: 'all',
    resultCount: 1,
    topSimilarity: 0.2,
    topTier: 'raw',
    topSessionId,
  };
}

describe('selectTargetedSessions', () => {
  const row = (topSessionId: string | null, count = 1, topTier: string | null = 'raw'): UnmetDemandRow => ({
    query: 'q' + topSessionId,
    count,
    latestTs: '2026-01-01',
    topSessionId,
    topTier,
  });

  test('keeps distinct session ids in order, dropping null/empty', () => {
    expect(selectTargetedSessions([row('a'), row(null), row(''), row('b')])).toEqual(['a', 'b']);
  });

  test('skips non-raw groups — already-compiled sessions must not burn the cap', () => {
    expect(
      selectTargetedSessions([row('a', 1, 'dream'), row('b', 1, 'wiki'), row('c', 1, null), row('d', 1, 'raw')])
    ).toEqual(['d']);
  });

  test('de-duplicates repeated session ids', () => {
    expect(selectTargetedSessions([row('a'), row('a'), row('b'), row('a')])).toEqual(['a', 'b']);
  });

  test('caps the list at the per-night limit', () => {
    const rows = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((s) => row(s));
    expect(selectTargetedSessions(rows)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });
});

describe('synthesisRunCommand', () => {
  let dbPath: string;
  let configPath: string;
  let config: EngramConfig;
  let store: LocalStore;

  // Recording seams: every synthesize/ingest call and the phase-line stream.
  let synthCalls: SynthesizeParams[];
  let ingestCount: number;
  let events: string[];
  let logs: Array<{ phase: string; data: Record<string, unknown> }>;
  let lockAcquired: number;
  let lockReleased: number;

  // Synthesize/ingest fakes never touch the collaborators, so a bare object is
  // enough to satisfy the bundle the orchestration hands through.
  const fakeCollaborators = (): SynthesisCollaborators =>
    ({ backend: { close: async () => {} }, embedder: {}, dreamLLM: {}, wikiLLM: {}, wikiStore: {} }) as unknown as SynthesisCollaborators;

  const baseDeps = (over: Partial<SynthesisRunDeps> = {}): SynthesisRunDeps => ({
    config,
    local: store,
    acquireLock: () => {
      lockAcquired++;
      return { release: () => { lockReleased++; } };
    },
    collaborators: async () => fakeCollaborators(),
    synthesize: async (params) => {
      synthCalls.push(params);
      events.push(params.sessionId ? 'synth:' + params.sessionId : 'synth:main');
      return synthResult();
    },
    ingest: async () => {
      ingestCount++;
      events.push('ingest');
      return wikiResult();
    },
    // Default lint fake: the fake collaborators carry a bare wikiStore, so the
    // real lintWiki can't run against it. Individual tests override this.
    lint: async () => [],
    log: (phase, data) => logs.push({ phase, data }),
    ...over,
  });

  beforeEach(() => {
    dbPath = join(tmpdir(), `engram-synthrun-${crypto.randomUUID()}.sqlite`);
    store = new LocalStore(dbPath);
    configPath = join(tmpdir(), `engram-synthrun-cfg-${crypto.randomUUID()}.json`);
    process.env.ENGRAM_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({ openaiApiKey: 'sk-TESTONLY', databaseUrl: 'postgres://x/db', embeddingProvider: 'local' })
    );
    config = loadConfig();
    synthCalls = [];
    ingestCount = 0;
    events = [];
    logs = [];
    lockAcquired = 0;
    lockReleased = 0;
  });

  afterEach(() => {
    delete process.env.ENGRAM_CONFIG_PATH;
    // The command leaves an injected store open (creator closes) — close it here.
    try { store.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbPath + suffix); } catch { /* best effort */ }
    }
    try { rmSync(configPath, { force: true }); } catch { /* best effort */ }
  });

  const phase = (name: string) => logs.find((l) => l.phase === name);

  test('empty demand log: only the main dream pass runs, demand line is all zeros', async () => {
    await synthesisRunCommand(baseDeps());

    // Exactly one synthesize call (the main dream pass) — no targeted passes.
    expect(synthCalls).toHaveLength(1);
    expect(synthCalls[0]!.sessionId).toBeUndefined();
    expect(synthCalls[0]!).toMatchObject({ sourceOwner: 'derek', dreamOwner: 'derek', limit: 1000, dryRun: false });
    expect(ingestCount).toBe(1);

    // Phase stream, in order — lint runs after wiki, before done.
    expect(logs.map((l) => l.phase)).toEqual(['dream', 'demand', 'wiki', 'lint', 'done']);
    expect(phase('demand')!.data).toMatchObject({
      days: 30,
      total: 0,
      unmet: 0,
      unmetQueries: 0,
      targetedSessions: 0,
      targetedSynthesized: 0,
      targetedDreamChunks: 0,
    });

    // Lock taken and released; stamps written.
    expect(lockAcquired).toBe(1);
    expect(lockReleased).toBe(1);
    expect(store.getStat('last_synthesis_at')).not.toBeNull();
  });

  test('seeded unmet row with raw coverage triggers a targeted dream pass for that session', async () => {
    store.logDemand(weakSearch('how does the lock work', 'sess-known'));

    await synthesisRunCommand(baseDeps());

    const targeted = synthCalls.filter((c) => c.sessionId !== undefined);
    expect(targeted.map((c) => c.sessionId)).toEqual(['sess-known']);
    expect(targeted[0]!).toMatchObject({ sourceOwner: 'derek', dreamOwner: 'derek', limit: 1000, dryRun: false });
    // Targeted passes carry no `since` window — old backfilled sessions must compile.
    expect(targeted[0]!.since).toBeUndefined();
    expect(phase('demand')!.data).toMatchObject({ targetedSessions: 1, unmet: 1 });
  });

  test('targeted passes run after the main dream and before the wiki phase', async () => {
    store.logDemand(weakSearch('query one', 'sess-a'));

    await synthesisRunCommand(baseDeps());

    expect(events).toEqual(['synth:main', 'synth:sess-a', 'ingest']);
    const demandIdx = logs.findIndex((l) => l.phase === 'demand');
    const wikiIdx = logs.findIndex((l) => l.phase === 'wiki');
    expect(demandIdx).toBeGreaterThanOrEqual(0);
    expect(demandIdx).toBeLessThan(wikiIdx);
  });

  test('more than five distinct sessions are capped at five per night', async () => {
    for (let i = 0; i < 7; i++) store.logDemand(weakSearch('distinct query ' + i, 'sess-' + i));

    await synthesisRunCommand(baseDeps());

    const targeted = synthCalls.filter((c) => c.sessionId !== undefined).map((c) => c.sessionId!);
    expect(targeted).toHaveLength(5);
    expect(new Set(targeted).size).toBe(5);
  });

  test('duplicate raw coverage across queries collapses to one targeted pass', async () => {
    store.logDemand(weakSearch('first phrasing', 'sess-shared'));
    store.logDemand(weakSearch('second phrasing', 'sess-shared'));

    await synthesisRunCommand(baseDeps());

    const targeted = synthCalls.filter((c) => c.sessionId !== undefined).map((c) => c.sessionId!);
    expect(targeted).toEqual(['sess-shared']);
  });

  test('targeted dream chunk counts roll up into the demand phase line', async () => {
    store.logDemand(weakSearch('rollup query', 'sess-rollup'));

    await synthesisRunCommand(
      baseDeps({
        synthesize: async (params) => {
          synthCalls.push(params);
          return params.sessionId ? synthResult({ synthesized: 2, dreamChunks: 9 }) : synthResult();
        },
      })
    );

    expect(phase('demand')!.data).toMatchObject({ targetedSessions: 1, targetedSynthesized: 2, targetedDreamChunks: 9 });
  });

  test('a held lock short-circuits: no synthesis, no ingest, skipped line only', async () => {
    store.logDemand(weakSearch('would target', 'sess-x'));

    await synthesisRunCommand(baseDeps({ acquireLock: () => null }));

    expect(synthCalls).toHaveLength(0);
    expect(ingestCount).toBe(0);
    expect(logs.map((l) => l.phase)).toEqual(['skipped']);
    expect(lockReleased).toBe(0);
  });

  test('a config cap of 0 disables the targeted pass entirely', async () => {
    for (let i = 0; i < 3; i++) store.logDemand(weakSearch('capped query ' + i, 'sess-' + i));
    config.synthesis.targetedSessionsPerNight = 0;

    await synthesisRunCommand(baseDeps());

    const targeted = synthCalls.filter((c) => c.sessionId !== undefined);
    expect(targeted).toHaveLength(0);
    expect(phase('demand')!.data).toMatchObject({ targetedSessions: 0 });
    // The main dream pass and wiki ingest still run.
    expect(synthCalls).toHaveLength(1);
    expect(ingestCount).toBe(1);
  });

  test('a config cap of 2 limits three eligible sessions to two targeted passes', async () => {
    for (let i = 0; i < 3; i++) store.logDemand(weakSearch('eligible query ' + i, 'sess-' + i));
    config.synthesis.targetedSessionsPerNight = 2;

    await synthesisRunCommand(baseDeps());

    const targeted = synthCalls.filter((c) => c.sessionId !== undefined).map((c) => c.sessionId!);
    expect(targeted).toHaveLength(2);
    expect(new Set(targeted).size).toBe(2);
    expect(phase('demand')!.data).toMatchObject({ targetedSessions: 2 });
  });

  test('a since window is derived from the last-synthesis stamp for the main pass', async () => {
    store.setStat('last_synthesis_at', '2026-01-10T00:00:00.000Z');

    await synthesisRunCommand(baseDeps());

    const main = synthCalls.find((c) => c.sessionId === undefined)!;
    // 24h overlap subtracted from the stamp.
    expect(main.since?.toISOString()).toBe('2026-01-09T00:00:00.000Z');
  });

  test('emits a lint phase line after wiki and before done, rolling up rule counts', async () => {
    const findings: Finding[] = [
      { severity: 'warn', rule: 'orphan', page: 'a', detail: 'x' },
      { severity: 'warn', rule: 'orphan', page: 'b', detail: 'y' },
      { severity: 'warn', rule: 'pending-unit', page: '', detail: 'z' },
      { severity: 'info', rule: 'stub', page: 'c', detail: 'short' },
    ];
    await synthesisRunCommand(baseDeps({ lint: async () => findings }));

    expect(logs.map((l) => l.phase)).toEqual(['dream', 'demand', 'wiki', 'lint', 'done']);
    expect(phase('lint')!.data).toMatchObject({ warns: 3, infos: 1, rules: { orphan: 2, 'pending-unit': 1, stub: 1 } });
  });

  test('a lint throw is logged as a lint error and does not fail the run', async () => {
    await synthesisRunCommand(
      baseDeps({
        lint: async () => {
          throw new Error('lint boom');
        },
      })
    );

    expect(phase('lint')!.data).toMatchObject({ error: 'lint boom' });
    // The run still completes: wiki + done phases present, stamps written.
    expect(logs.some((l) => l.phase === 'done')).toBe(true);
    expect(store.getStat('last_synthesis_at')).not.toBeNull();
  });

  test('demand + lint phase lines land as trend snapshots via the injected store', async () => {
    const findings: Finding[] = [
      { severity: 'warn', rule: 'orphan', page: 'a', detail: 'x' },
      { severity: 'info', rule: 'stub', page: 'b', detail: 'y' },
    ];
    store.logDemand(weakSearch('rollup query', 'sess-rollup'));

    await synthesisRunCommand(baseDeps({ lint: async () => findings }));

    const demandSnaps = store.getSnapshots('demand');
    expect(demandSnaps.length).toBe(1);
    // Snapshot payload mirrors the demand phase line exactly.
    expect(demandSnaps[0]!.payload).toEqual(phase('demand')!.data);
    expect(demandSnaps[0]!.payload).toMatchObject({ targetedSessions: 1, unmet: 1 });

    const lintSnaps = store.getSnapshots('lint');
    expect(lintSnaps.length).toBe(1);
    expect(lintSnaps[0]!.payload).toEqual({ warns: 1, infos: 1, rules: { orphan: 1, stub: 1 } });
  });

  test('a snapshot write failure never fails the run', async () => {
    // Break both snapshot writes; the run must still complete with stamps set.
    store.addSnapshot = () => {
      throw new Error('snapshot boom');
    };

    await synthesisRunCommand(baseDeps({ lint: async () => [{ severity: 'warn', rule: 'orphan', page: 'a', detail: 'x' }] }));

    expect(logs.some((l) => l.phase === 'done')).toBe(true);
    expect(phase('demand')).toBeDefined();
    expect(phase('lint')!.data).toMatchObject({ warns: 1 });
    expect(store.getStat('last_synthesis_at')).not.toBeNull();
  });
});
