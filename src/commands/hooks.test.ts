import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHookSnippet,
  hookStatus,
  installHook,
  uninstallHook,
  SettingsParseError,
} from './hooks.ts';
import { indexPath } from './service.ts';

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

describe('hookStatus / installHook / uninstallHook', () => {
  let dir: string;
  let settingsPath: string;

  const backups = () => readdirSync(dir).filter((f) => f.includes('.engram-') && f.endsWith('.bak'));
  const read = () => readFileSync(settingsPath, 'utf-8');
  const readJson = () => JSON.parse(read());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'engram-hooks-'));
    settingsPath = join(dir, 'settings.json');
    process.env.ENGRAM_CLAUDE_SETTINGS = settingsPath;
  });
  afterEach(() => {
    delete process.env.ENGRAM_CLAUDE_SETTINGS;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('fresh missing file → install creates minimal valid settings carrying the hook', () => {
    expect(hookStatus()).toEqual({ installed: false, stalePath: false, path: settingsPath });
    const r = installHook();
    expect(r.changed).toBe(true);
    expect(r.backupPath).toBeUndefined(); // nothing to back up when we create the file
    expect(backups().length).toBe(0);

    const obj = readJson();
    // Only the hooks key exists — a minimal, valid file.
    expect(Object.keys(obj)).toEqual(['hooks']);
    const entry = obj.hooks.SessionStart[0];
    expect(entry.matcher).toBe('startup|clear');
    expect(entry.hooks[0].command).toContain('context --cwd "$CLAUDE_PROJECT_DIR"');
    expect(entry.hooks[0].command).toContain(indexPath());

    const st = hookStatus();
    expect(st.installed).toBe(true);
    expect(st.stalePath).toBe(false);
  });

  test('existing file with unrelated hooks → those keys preserved exactly, hook appended', () => {
    const existing = {
      model: 'opus',
      permissions: { allow: ['Bash'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    const r = installHook();
    expect(r.changed).toBe(true);
    expect(r.backupPath).toBeDefined();
    expect(backups().length).toBe(1);

    const obj = readJson();
    // Untouched keys are byte-for-byte the same shape.
    expect(obj.model).toBe('opus');
    expect(obj.permissions).toEqual({ allow: ['Bash'] });
    expect(obj.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    // The engram hook was appended alongside the existing SessionStart array.
    expect(obj.hooks.SessionStart.length).toBe(1);
    expect(obj.hooks.SessionStart[0].hooks[0].command).toContain(indexPath());
  });

  test('appends to a pre-existing SessionStart array without disturbing its entries', () => {
    const existing = {
      hooks: {
        SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    installHook();
    const obj = readJson();
    expect(obj.hooks.SessionStart.length).toBe(2);
    expect(obj.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
    expect(obj.hooks.SessionStart[1].hooks[0].command).toContain(indexPath());
  });

  test('double install is idempotent — byte-identical, no second backup', () => {
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }, null, 2));
    const first = installHook();
    expect(first.changed).toBe(true);
    expect(backups().length).toBe(1);
    const afterFirst = read();

    const second = installHook();
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeUndefined();
    // File unchanged and NO second backup written.
    expect(read()).toBe(afterFirst);
    expect(backups().length).toBe(1);
  });

  test('malformed JSON → install AND uninstall both refuse; file untouched, no backup', () => {
    const garbage = '{ this is not json ]';
    writeFileSync(settingsPath, garbage);

    expect(() => installHook()).toThrow(SettingsParseError);
    expect(() => uninstallHook()).toThrow(SettingsParseError);
    expect(read()).toBe(garbage);
    expect(backups().length).toBe(0);
    // hookStatus flags the parse error rather than throwing.
    expect(hookStatus()).toEqual({ installed: false, stalePath: false, path: settingsPath, parseError: true });
  });

  test('uninstall removes only matching entries and prunes empties it created', () => {
    installHook();
    const r = uninstallHook();
    expect(r.changed).toBe(true);
    expect(r.backupPath).toBeDefined();
    const obj = readJson();
    // SessionStart was the only entry we created → the whole hooks object is pruned.
    expect('hooks' in obj).toBe(false);
    expect(hookStatus().installed).toBe(false);
  });

  test('uninstall preserves sibling hooks and a foreign SessionStart entry', () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    installHook(); // appends engram's entry as a second SessionStart element

    const r = uninstallHook();
    expect(r.changed).toBe(true);
    const obj = readJson();
    // PreToolUse untouched; the foreign SessionStart entry survives; engram's is gone.
    expect(obj.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(obj.hooks.SessionStart).toEqual(existing.hooks.SessionStart);
  });

  test('uninstall strips only the engram command from a shared SessionStart entry', () => {
    // A single entry whose hooks[] holds both a foreign command AND engram's.
    const cmd = buildHookSnippet().hooks.SessionStart[0]!.hooks[0]!.command;
    const existing = {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: 'echo keep' },
              { type: 'command', command: cmd },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    expect(hookStatus().installed).toBe(true);

    uninstallHook();
    const obj = readJson();
    expect(obj.hooks.SessionStart[0].hooks).toEqual([{ type: 'command', command: 'echo keep' }]);
  });

  test('uninstall on a not-installed file is a no-op with no backup', () => {
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }, null, 2));
    const before = read();
    const r = uninstallHook();
    expect(r.changed).toBe(false);
    expect(read()).toBe(before);
    expect(backups().length).toBe(0);
  });

  test('uninstall on a missing file is a no-op', () => {
    expect(existsSync(settingsPath)).toBe(false);
    expect(uninstallHook().changed).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
  });

  test('stale-path detection: engram context via a different src/index.ts', () => {
    const existing = {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|clear',
            hooks: [{ type: 'command', command: '/old/moved/repo/src/index.ts context --cwd "$CLAUDE_PROJECT_DIR"' }],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    const st = hookStatus();
    expect(st.installed).toBe(true);
    expect(st.stalePath).toBe(true);
  });

  test('install repairs a stale hook in place: stale entry replaced, one backup, status current', () => {
    const existing = {
      model: 'keep-me',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/keep/foreign.sh' }] }],
        SessionStart: [
          {
            matcher: 'startup|clear',
            hooks: [{ type: 'command', command: '/old/moved/repo/src/index.ts context --cwd "$CLAUDE_PROJECT_DIR"' }],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    expect(hookStatus().stalePath).toBe(true);

    const r = installHook();
    expect(r.changed).toBe(true);
    expect(r.backupPath).toBeDefined();

    const after = hookStatus();
    expect(after.installed).toBe(true);
    expect(after.stalePath).toBe(false);

    const obj = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Stale entry gone, exactly one (current) engram entry remains; foreign keys intact.
    expect(obj.model).toBe('keep-me');
    expect(obj.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    const commands = obj.hooks.SessionStart.flatMap((e: { hooks: Array<{ command: string }> }) =>
      e.hooks.map((h) => h.command)
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain('/old/moved/repo/');
  });
});
