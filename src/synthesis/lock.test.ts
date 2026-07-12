import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSynthesisLock, claimStaleLock } from './lock.ts';

// Redirect the lock to a scratch path (env seam) so no test touches ~/.engram.
let lockPath: string;

function ageFile(path: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  utimesSync(path, t, t);
}

describe('acquireSynthesisLock', () => {
  beforeEach(() => {
    lockPath = join(tmpdir(), `engram-lock-${crypto.randomUUID()}.lock`);
    process.env.ENGRAM_SYNTHESIS_LOCK_PATH = lockPath;
  });
  afterEach(() => {
    delete process.env.ENGRAM_SYNTHESIS_LOCK_PATH;
    try {
      rmSync(lockPath);
    } catch {
      // best effort
    }
  });

  test('double-acquire returns null the second time', () => {
    const first = acquireSynthesisLock();
    expect(first).not.toBeNull();
    const second = acquireSynthesisLock();
    expect(second).toBeNull();
    first!.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('dead holder + mtime older than 30 min is reclaimed', () => {
    // A pid that (almost certainly) no longer exists.
    writeFileSync(lockPath, `999999\n${new Date().toISOString()}\n`);
    ageFile(lockPath, 31 * 60 * 1000);

    const lock = acquireSynthesisLock();
    expect(lock).not.toBeNull();
    // We now own it (our pid recorded).
    expect(readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe(String(process.pid));
    lock!.release();
  });

  test('live holder with old mtime (< 6h) is NOT reclaimed', () => {
    // Our own live pid; 40 min old → past the 30-min idle floor but holder alive.
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
    ageFile(lockPath, 40 * 60 * 1000);

    const lock = acquireSynthesisLock();
    expect(lock).toBeNull();
  });

  test('heartbeat advances the lock mtime', async () => {
    const lock = acquireSynthesisLock({ heartbeatMs: 25 });
    expect(lock).not.toBeNull();
    const before = statSync(lockPath).mtimeMs;
    await Bun.sleep(90);
    const after = statSync(lockPath).mtimeMs;
    expect(after).toBeGreaterThan(before);
    lock!.release();
  });

  // Review-confirmed race: two processes both judge the same dead lock stale;
  // the winner reclaims and writes a FRESH lock, then the loser's bare unlink
  // (old code) deleted that fresh lock and the loser acquired too — two
  // concurrent synthesis holders. The rename-verify claim must lose instead.
  test("a racing reclaimer with a stale judgment cannot evict the winner's fresh lock", () => {
    // Stale lock: dead holder, 31 min idle.
    writeFileSync(lockPath, `999999\n2020-01-01T00:00:00.000Z\n`);
    ageFile(lockPath, 31 * 60 * 1000);
    // The slower reclaimer (B) snapshots its staleness judgment first…
    const judged = readFileSync(lockPath, 'utf-8');
    // …then the winner (A) reclaims and now holds a fresh lock at the same path.
    const winner = acquireSynthesisLock();
    expect(winner).not.toBeNull();
    // B's claim must fail AND leave A's fresh lock in place.
    expect(claimStaleLock(lockPath, judged)).toBe(false);
    expect(readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe(String(process.pid));
    winner!.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('claiming an unchanged stale lock succeeds exactly once', () => {
    writeFileSync(lockPath, `999999\n2020-01-01T00:00:00.000Z\n`);
    const judged = readFileSync(lockPath, 'utf-8');
    expect(claimStaleLock(lockPath, judged)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    // A second claim of the now-gone file loses cleanly.
    expect(claimStaleLock(lockPath, judged)).toBe(false);
  });

  test('release removes only our own lock', () => {
    const lock = acquireSynthesisLock();
    expect(lock).not.toBeNull();
    // Someone else reclaimed the path (different pid recorded).
    writeFileSync(lockPath, `12345\n${new Date().toISOString()}\n`);
    lock!.release();
    // Not ours → left intact.
    expect(existsSync(lockPath)).toBe(true);
  });
});
