import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isKnownJobKind, jobStatus, startJob, JobConflictError, __resetJobs } from './jobs.ts';

describe('jobs', () => {
  let logPath: string;

  beforeEach(() => {
    __resetJobs();
    logPath = join(tmpdir(), `engram-askeval-log-${crypto.randomUUID()}.log`);
    process.env.ENGRAM_ASKEVAL_LOG = logPath;
  });
  afterEach(() => {
    delete process.env.ENGRAM_ASKEVAL_LOG;
    try { rmSync(logPath, { force: true }); } catch { /* may never be created */ }
  });

  test('whitelist: only known kinds pass', () => {
    expect(isKnownJobKind('askeval')).toBe(true);
    expect(isKnownJobKind('backfill')).toBe(false);
    expect(isKnownJobKind('__proto__')).toBe(false);
    expect(isKnownJobKind('')).toBe(false);
  });

  test('startJob rejects an unknown kind (never spawns)', () => {
    let spawned = false;
    const spawn = (() => {
      spawned = true;
      return { exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;
    expect(() => startJob('bogus', [], spawn)).toThrow('unknown job kind');
    expect(spawned).toBe(false);
  });

  test('single-flight: a second start while running throws JobConflictError', async () => {
    // A controllable child: exited stays pending until we resolve it.
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((r) => { resolveExit = r; });
    const spawn = (() => ({ exited })) as unknown as typeof Bun.spawn;

    startJob('askeval', ['--limit', '5'], spawn);
    expect(jobStatus('askeval').running).toBe(true);
    expect(jobStatus('askeval').startedAt).not.toBeNull();

    // Second launch is refused while the first is in flight.
    expect(() => startJob('askeval', [], spawn)).toThrow(JobConflictError);

    // Completion flips running off and records the exit code.
    resolveExit(0);
    await exited;
    await new Promise((r) => setTimeout(r, 0));
    expect(jobStatus('askeval').running).toBe(false);
    expect(jobStatus('askeval').exitCode).toBe(0);

    // Once done, a new run is allowed again.
    const exited2 = Promise.resolve(0);
    startJob('askeval', [], (() => ({ exited: exited2 })) as unknown as typeof Bun.spawn);
    expect(jobStatus('askeval').running).toBe(true);
    await exited2;
    await new Promise((r) => setTimeout(r, 0));
  });

  test('status reflects a real short-lived process: exitCode 0 + tailed log', async () => {
    // Inject a spawn that runs a fast `bun -e` writing to the same stdio fds, so
    // the log tail and exit code are exercised end to end without the real eval.
    const spawn = ((_argv: string[], opts: Parameters<typeof Bun.spawn>[1]) =>
      Bun.spawn(['bun', '-e', 'process.stdout.write("hello from job\\n")'], opts)) as unknown as typeof Bun.spawn;

    startJob('askeval', [], spawn);
    const rec = jobStatus('askeval');
    expect(rec.running).toBe(true);

    // Wait for the child to finish (poll the status seam).
    for (let i = 0; i < 200 && jobStatus('askeval').running; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const done = jobStatus('askeval');
    expect(done.running).toBe(false);
    expect(done.exitCode).toBe(0);
    expect(done.lastLines).toContain('hello from job');
  });
});
