import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { ENGRAM_DIR, ensureEngramDir } from '../config/index.ts';

const LOCK_PATH = join(ENGRAM_DIR, 'synthesis.lock');
const STALE_MS = 30 * 60 * 1000;

export interface Lock {
  release(): void;
}

// Best-effort advisory lock shared by `dream`, `wiki ingest`, and `synthesis-run`
// so the watcher hook, the nightly agent, and a manual run can't interleave LLM
// synthesis. Not fcntl — a stale lock (mtime older than 30 min) is reclaimed.
export function acquireSynthesisLock(): Lock | null {
  ensureEngramDir();
  if (existsSync(LOCK_PATH)) {
    try {
      const age = Date.now() - statSync(LOCK_PATH).mtimeMs;
      if (age < STALE_MS) return null;
    } catch {
      // fall through and try to take it
    }
  }
  writeFileSync(LOCK_PATH, `${process.pid}\n${new Date().toISOString()}\n`);
  return {
    release() {
      try {
        // Only remove the lock if it's still ours.
        const owner = readFileSync(LOCK_PATH, 'utf-8').split('\n')[0];
        if (owner === String(process.pid)) unlinkSync(LOCK_PATH);
      } catch {
        // best effort
      }
    },
  };
}
