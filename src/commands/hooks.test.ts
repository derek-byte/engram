import { describe, expect, test } from 'bun:test';
import { buildHookSnippet } from './hooks.ts';

describe('buildHookSnippet', () => {
  test('matches the documented SessionStart schema', () => {
    const snippet = buildHookSnippet();
    // Parses as JSON (round-trips) and has the documented nesting.
    const parsed = JSON.parse(JSON.stringify(snippet));
    const entry = parsed.hooks.SessionStart[0];
    expect(entry.matcher).toBe('startup|clear');
    const hook = entry.hooks[0];
    expect(hook.type).toBe('command');
    expect(typeof hook.timeout).toBe('number');
    expect(hook.timeout).toBe(10);
  });

  test('command uses absolute paths and passes the session cwd', () => {
    const hook = buildHookSnippet().hooks.SessionStart[0]!.hooks[0]!;
    expect(hook.command).toContain('context --cwd "$CLAUDE_PROJECT_DIR"');
    // Absolute index path (worktree/repo root + src/index.ts).
    expect(hook.command).toContain('src/index.ts');
    expect(hook.command).toMatch(/\s\/.*src\/index\.ts context/);
  });
});
