import { join } from 'node:path';
import { readFileSync, unlinkSync, statSync, openSync, writeSync, closeSync, utimesSync } from 'node:fs';
import { ENGRAM_DIR, ensureEngramDir } from '../config/index.ts';

// A held lock is stale once its holder is gone AND it has sat idle past this;
// the heartbeat (below) keeps a live holder's mtime fresh so it never trips.
const STALE_MS = 30 * 60 * 1000;
// Hard cap regardless of the pid check — guards against pid reuse making a dead
// holder's pid resolve to some unrelated live process forever.
const HARD_CAP_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MS = 60_000;

// Resolve at call time so a test can redirect the lock to a scratch path via
// ENGRAM_SYNTHESIS_LOCK_PATH (mirrors the ENGRAM_CONFIG_PATH seam). No test may
// ever touch the real ~/.engram/synthesis.lock.
function resolveLockPath(): string {
  return process.env.ENGRAM_SYNTHESIS_LOCK_PATH ?? join(ENGRAM_DIR, 'synthesis.lock');
}

export interface Lock {
  release(): void;
}

// Atomically create the lock file (O_EXCL): throws EEXIST if it already exists,
// which is what kills the old existsSync()→writeFileSync() TOCTOU race.
function writeLock(path: string): void {
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
}

// Is the process recorded in the lock file gone? kill(pid, 0) delivers no signal
// but throws ESRCH when no such process exists (EPERM ⇒ alive but not ours).
function holderDead(path: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(path, 'utf-8').split('\n')[0]);
  } catch {
    return false; // unreadable → don't assume dead
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false; // alive
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function lockAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Infinity; // vanished between checks → treat as reclaimable
  }
}

// Wrap an acquired lock: refresh mtime on an interval so a long-running holder is
// never mistaken for stale, and release() stops the heartbeat then unlinks iff
// we're still the recorded owner (never yank someone else's reclaimed lock).
function makeLock(path: string, heartbeatMs: number): Lock {
  const timer = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // lock file gone — nothing to refresh
    }
  }, heartbeatMs);
  timer.unref();
  return {
    release() {
      clearInterval(timer);
      try {
        const owner = readFileSync(path, 'utf-8').split('\n')[0];
        if (owner === String(process.pid)) unlinkSync(path);
      } catch {
        // best effort
      }
    },
  };
}

// Best-effort advisory lock shared by `dream`, `wiki ingest`, and `synthesis-run`
// so the watcher hook, the nightly agent, and a manual run can't interleave LLM
// synthesis. Not fcntl — a stale lock (dead holder idle > 30 min, or a 6h hard
// cap) is reclaimed with a single retry. `heartbeatMs` is a test seam only.
export function acquireSynthesisLock(opts: { heartbeatMs?: number } = {}): Lock | null {
  ensureEngramDir();
  const path = resolveLockPath();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;

  try {
    writeLock(path);
    return makeLock(path, heartbeatMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Held. Reclaim only a demonstrably stale lock.
  const age = lockAgeMs(path);
  const stale = (holderDead(path) && age > STALE_MS) || age > HARD_CAP_MS;
  if (!stale) return null;

  try {
    unlinkSync(path);
  } catch {
    // someone else may have removed it first; the retry decides the winner
  }
  try {
    writeLock(path);
    return makeLock(path, heartbeatMs);
  } catch {
    return null; // lost the reclaim race → treat as held
  }
}
