import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveFromCwd } from './resolve.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

describe('resolveFromCwd', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'engram-resolve-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('git repo → basename(toplevel) + branch', () => {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'a@b.c');
    git(dir, 'config', 'user.name', 'a');
    execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-q', '-m', 'init']);
    const r = resolveFromCwd(dir);
    // macOS tmpdir symlinks /var→/private/var; basename is stable regardless.
    expect(r.repo).toBe(basename(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim()));
    expect(r.branch).toBe('main');
  });

  test('detached HEAD → no branch', () => {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'a@b.c');
    git(dir, 'config', 'user.name', 'a');
    execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-q', '-m', 'c1']);
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    git(dir, 'checkout', '-q', sha);
    const r = resolveFromCwd(dir);
    expect(r.branch).toBeUndefined();
  });

  test('non-git dir → basename(cwd), no branch', () => {
    const r = resolveFromCwd(dir);
    expect(r.repo).toBe(basename(dir));
    expect(r.branch).toBeUndefined();
  });
});
