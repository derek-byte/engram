import { join } from 'node:path';
import { readFileSync, renameSync, unlinkSync, statSync, openSync, writeSync, closeSync, utimesSync } from 'node:fs';
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

// Is the process recorded in the lock content gone? kill(pid, 0) delivers no
// signal but throws ESRCH when no such process exists (EPERM ⇒ alive, not ours).
// Takes the content (not the path) so the staleness verdict and the claim below
// are judged against the SAME bytes — no re-read window.
function holderDead(lockContent: string): boolean {
  const pid = Number(lockContent.split('\n')[0]);
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

// Atomically claim a stale lock: rename it aside (rename can be won by exactly
// one process), then verify the claimed file still holds the bytes that were
// judged stale. Without the verify, two racing reclaimers interleave so the
// slower one's unlink deletes the winner's freshly written lock and BOTH end up
// holding — the exact double-run the lock exists to prevent. A content mismatch
// means we grabbed someone's fresh lock: put it back and lose. Exported only for
// the race regression test.
export function claimStaleLock(path: string, judgedContent: string): boolean {
  const claimPath = `${path}.claim.${process.pid}`;
  let claimed: string;
  try {
    renameSync(path, claimPath);
    claimed = readFileSync(claimPath, 'utf-8');
  } catch {
    return false; // another claimer won the rename (or the holder released)
  }
  if (claimed !== judgedContent) {
    try {
      renameSync(claimPath, path); // restore the fresh lock we grabbed
    } catch {
      try {
        unlinkSync(claimPath);
      } catch {
        // best effort — never leave the claim file around
      }
    }
    return false;
  }
  try {
    unlinkSync(claimPath);
  } catch {
    // best effort — the lock path itself is already free
  }
  return true;
}

// Best-effort advisory lock shared by `dream`, `wiki ingest`, and `synthesis-run`
// so the watcher hook, the nightly agent, and a manual run can't interleave LLM
// synthesis. Not fcntl — a stale lock (dead holder idle > 30 min, or a 6h hard
// cap) is reclaimed via the rename-verify claim above. `heartbeatMs` is a test
// seam only.
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

  // Held. Reclaim only a demonstrably stale lock, judged and claimed against one
  // read of the file's content.
  let judged: string;
  try {
    judged = readFileSync(path, 'utf-8');
  } catch {
    return null; // vanished — released or claimed; the next acquire gets it clean
  }
  const age = lockAgeMs(path);
  const stale = (holderDead(judged) && age > STALE_MS) || age > HARD_CAP_MS;
  if (!stale) return null;

  if (!claimStaleLock(path, judged)) return null;
  try {
    writeLock(path);
    return makeLock(path, heartbeatMs);
  } catch {
    return null; // a fresh acquirer slipped in after our claim → treat as held
  }
}
