import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextCommand } from './context.ts';
import { LocalStore } from '../storage/local.ts';

// contextCommand builds its own live PgVectorBackend, so the success path is
// covered by src/context/compose.test.ts (buildContext against a FakeBackend).
// These tests pin the logging *boundary*: context injection is logged ONLY after
// buildContext succeeds, so the early-return guards (disabled / not configured)
// must never write a context_log row — and must never throw or print to stdout.
describe('contextCommand injection logging', () => {
  let dbPath: string;
  let configPath: string;
  let logOut: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;
  let origDbUrl: string | undefined;

  beforeEach(() => {
    dbPath = join(tmpdir(), `engram-ctx-${crypto.randomUUID()}.sqlite`);
    configPath = join(tmpdir(), `engram-ctx-cfg-${crypto.randomUUID()}.json`);
    process.env.ENGRAM_LOCAL_DB = dbPath;
    process.env.ENGRAM_CONFIG_PATH = configPath;
    // loadConfig folds ENGRAM_DATABASE_URL into databaseUrl; clear it so the
    // "not configured" guard is deterministic and no test can reach live pg.
    origDbUrl = process.env.ENGRAM_DATABASE_URL;
    delete process.env.ENGRAM_DATABASE_URL;
    logOut = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...a: unknown[]) => { logOut.push(a.join(' ')); };
    console.error = () => {}; // swallow the stderr status line
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    delete process.env.ENGRAM_LOCAL_DB;
    delete process.env.ENGRAM_CONFIG_PATH;
    if (origDbUrl === undefined) delete process.env.ENGRAM_DATABASE_URL;
    else process.env.ENGRAM_DATABASE_URL = origDbUrl;
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbPath + suffix); } catch { /* best effort */ }
    }
    try { rmSync(configPath, { force: true }); } catch { /* best effort */ }
  });

  const rowCount = (): number => {
    const s = new LocalStore(dbPath);
    try {
      return s.contextStats(3650).count;
    } finally {
      s.close();
    }
  };

  test('disabled injection: silent, exit-0, and nothing logged', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ databaseUrl: 'postgres://x/db', embeddingProvider: 'local', contextInjection: { enabled: false } })
    );

    await contextCommand({}); // text mode

    expect(logOut).toEqual([]); // silent-empty
    expect(rowCount()).toBe(0); // guard returns before buildContext → no log
  });

  test('not configured: silent, exit-0, and nothing logged', async () => {
    // enabled but missing databaseUrl → configIsComplete false → early return.
    writeFileSync(configPath, JSON.stringify({ embeddingProvider: 'local', contextInjection: { enabled: true } }));

    await contextCommand({});

    expect(logOut).toEqual([]);
    expect(rowCount()).toBe(0);
  });

  test('--json on a disabled guard still emits one empty object and logs nothing', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ databaseUrl: 'postgres://x/db', embeddingProvider: 'local', contextInjection: { enabled: false } })
    );

    await contextCommand({ repo: 'engram', json: true });

    expect(logOut.length).toBe(1);
    expect(JSON.parse(logOut[0]!)).toMatchObject({ repo: 'engram', pages: [], memories: [], estTokens: 0, markdown: '' });
    expect(rowCount()).toBe(0);
  });
});
