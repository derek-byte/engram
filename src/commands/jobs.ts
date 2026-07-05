import { join } from 'node:path';
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { ENGRAM_DIR, ensureEngramDir } from '../config/index.ts';
import { indexPath, repoRoot } from './service.ts';

// Job-kind whitelist, structured like isKnownServiceLabel in service.ts so a
// second kind is a one-line addition. Each kind maps to the hidden CLI
// subcommand the runner spawns (askeval → `engram askeval-run`).
const JOB_COMMANDS: Record<string, string> = {
  askeval: 'askeval-run',
};

export function isKnownJobKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(JOB_COMMANDS, kind);
}

// Per-kind append log. askeval honours ENGRAM_ASKEVAL_LOG (same env-seam
// philosophy as ENGRAM_LOCAL_DB / ENGRAM_CLAUDE_SETTINGS) so tests never write
// the developer's real ~/.engram/askeval.log.
export function jobLogPath(kind: string): string {
  if (kind === 'askeval') return process.env.ENGRAM_ASKEVAL_LOG ?? join(ENGRAM_DIR, 'askeval.log');
  return join(ENGRAM_DIR, `${kind}.log`);
}

// Thrown by startJob when a job of the same kind is already running — the route
// maps it to a 409. Single-flight per kind is enforced in-module.
export class JobConflictError extends Error {}

export interface JobStatus {
  running: boolean;
  startedAt: string | null;
  exitCode: number | null;
  lastLines: string[];
}

interface JobRecord {
  running: boolean;
  startedAt: string | null;
  exitCode: number | null;
}

// In-module single-flight state, keyed by kind. Survives for the life of the
// server process; a completed run keeps its startedAt/exitCode for status.
const records = new Map<string, JobRecord>();

// Tail the last `n` non-empty lines of a small log file. No dedicated helper
// exists (service.ts inlines the same slice); log files stay small so a plain
// readFile is fine.
function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

// Spawn seam: defaults to Bun.spawn. Injected in tests so single-flight and the
// running→done lifecycle are exercised against a fast, controllable process
// instead of the real (pg + paid-LLM) eval.
type SpawnFn = typeof Bun.spawn;

// Launch a whitelisted job as a detached child, appending stdout+stderr to the
// kind's log. Single-flight: throws JobConflictError if one is already running.
// Mirrors service.ts's spawn wiring (process.execPath + indexPath(), cwd=repo).
export function startJob(kind: string, args: string[], spawn: SpawnFn = Bun.spawn): void {
  if (!isKnownJobKind(kind)) throw new Error(`unknown job kind: ${kind}`);
  if (records.get(kind)?.running) throw new JobConflictError(`${kind} is already running`);

  ensureEngramDir();
  const fd = openSync(jobLogPath(kind), 'a');
  try {
    const proc = spawn([process.execPath, indexPath(), JOB_COMMANDS[kind]!, ...args], {
      cwd: repoRoot(),
      stdout: fd,
      stderr: fd,
    });
    const rec: JobRecord = { running: true, startedAt: new Date().toISOString(), exitCode: null };
    records.set(kind, rec);
    proc.exited
      .then((code) => {
        rec.running = false;
        rec.exitCode = code;
      })
      .catch(() => {
        rec.running = false;
      });
  } finally {
    // The child dup'd the fd during spawn; drop our copy so the server never
    // leaks descriptors across runs.
    closeSync(fd);
  }
}

export function jobStatus(kind: string): JobStatus {
  const rec = records.get(kind);
  return {
    running: rec?.running ?? false,
    startedAt: rec?.startedAt ?? null,
    exitCode: rec?.exitCode ?? null,
    lastLines: tailLines(jobLogPath(kind), 20),
  };
}

// Injected into the ui-server so route tests fake the runner without spawning —
// same seam philosophy as ServiceOps in ui.ts. uiCommand wires in the real ops.
export interface JobOps {
  start: (kind: string, args: string[]) => void;
  status: (kind: string) => JobStatus;
}

export const realJobOps: JobOps = {
  start: (kind, args) => startJob(kind, args),
  status: jobStatus,
};

// Test-only: clear in-module single-flight state between cases.
export function __resetJobs(): void {
  records.clear();
}
