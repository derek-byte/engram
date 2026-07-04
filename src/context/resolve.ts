import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';

// Resolve the repo/branch identity of a git checkout at `cwd`, matching the
// ingest convention repoFromCwd = basename(cwd). We prefer the git toplevel's
// basename (sessions usually start at the repo root, where ingest stamps repo),
// and fall back to basename(cwd) for a non-git directory. Branch feeds the
// header + keyword query only — never a hard filter (dream/wiki chunks store
// branch=''). Detached HEAD or any git failure → branch undefined.
export function resolveFromCwd(cwd: string): { repo: string; branch?: string } {
  const abs = resolve(cwd);
  const toplevel = git(abs, ['rev-parse', '--show-toplevel']);
  const repo = toplevel ? basename(toplevel) : basename(abs);
  const raw = git(abs, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = raw && raw !== 'HEAD' ? raw : undefined;
  return { repo, branch };
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
