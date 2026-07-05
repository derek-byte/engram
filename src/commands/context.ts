import { loadConfig, configIsComplete, clampContextBudget, DEFAULT_OWNER } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { WikiStore } from '../wiki/store.ts';
import { buildContext } from '../context/compose.ts';
import { resolveFromCwd } from '../context/resolve.ts';
import { LocalStore } from '../storage/local.ts';

export interface ContextOptions {
  repo?: string;
  branch?: string;
  cwd?: string;
  budget?: string;
  owner?: string;
  json?: boolean;
}

// Emit a compact, repo-scoped context block for a new Claude Code session.
// Contract: text mode is SILENT-EMPTY (prints nothing when there's nothing
// relevant); --json always prints one parseable object. Any operational failure
// (missing config, DB down, git error) → one stderr line, empty stdout, exit 0,
// so a SessionStart hook can never inject noise or an error banner.
export async function contextCommand(opts: ContextOptions): Promise<void> {
  let backend: PgVectorBackend | null = null;
  try {
    const config = loadConfig();
    // The kill switch: the SessionStart hook stays installed forever; flipping
    // contextInjection.enabled in ~/.engram/config.json turns injection off.
    if (!config.contextInjection.enabled) {
      console.error('engram context: disabled (contextInjection.enabled=false in ~/.engram/config.json)');
      return emitEmpty(opts);
    }
    if (!configIsComplete(config)) {
      console.error('engram context: not configured yet (run engram backfill first)');
      return emitEmpty(opts);
    }

    const { repo, branch } = resolveTarget(opts);
    const owner = opts.owner ?? DEFAULT_OWNER;
    const budgetTokens = parseBudget(opts.budget, config.contextInjection.budget);

    // connectTimeoutSec: 2 — the SessionStart hook path must fail fast so a dead
    // DB never stalls session startup (V1 fix).
    backend = PgVectorBackend.fromConfig(config, { connectTimeoutSec: 2 });
    // Read-only: skip initialize() (the ~20 DDL round-trips) to stay well under 2s.

    let store: WikiStore | null = null;
    try {
      store = new WikiStore(config.wikiDir);
    } catch {
      store = null; // display-only; excerpt fallback covers a missing wiki dir
    }

    const result = await buildContext({ repo, branch, owner, budgetTokens }, { backend, store });

    // Log every successful fire (including empty ones: empty-fires tell the
    // Analytics card how often injection runs but finds nothing). Airtight
    // try/catch: logging must never break silent-empty, the exit-0 guarantee,
    // or add meaningful latency.
    try {
      const local = new LocalStore();
      try {
        local.logContextInjection(result.repo, result.pages.length, result.memories.length, result.estTokens);
      } finally {
        local.close();
      }
    } catch {
      /* best effort — never affect the context output */
    }

    if (opts.json) {
      console.log(
        JSON.stringify({
          repo: result.repo,
          branch: result.branch ?? null,
          pages: result.pages,
          memories: result.memories,
          estTokens: result.estTokens,
          markdown: result.markdown,
        })
      );
    } else if (result.markdown) {
      console.log(result.markdown);
    }
    // text mode + empty markdown → print nothing (silent-empty)
  } catch (err) {
    // postgres.js connect failures throw AggregateError with an empty message —
    // fall back to code/name so the stderr line always says something.
    const e: Error & { code?: string } = err instanceof Error ? err : new Error(String(err));
    console.error(`engram context: ${e.message || e.code || e.name}`);
    emitEmpty(opts);
  } finally {
    if (backend) await backend.close();
  }
}

function resolveTarget(opts: ContextOptions): { repo: string; branch?: string } {
  if (opts.repo) return { repo: opts.repo, branch: opts.branch };
  return resolveFromCwd(opts.cwd ?? process.cwd());
}

// --budget flag > contextInjection.budget from config (already clamped by loadConfig).
function parseBudget(raw: string | undefined, configBudget: number): number {
  if (raw === undefined) return configBudget;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`engram context: invalid --budget ${raw}, using ${configBudget}`);
    return configBudget;
  }
  const clamped = clampContextBudget(n, configBudget);
  if (clamped !== Math.trunc(n)) {
    console.error(`engram context: --budget ${raw} clamped to ${clamped}`);
  }
  return clamped;
}

// --json still needs a parseable object on failure; text mode stays silent.
function emitEmpty(opts: ContextOptions): void {
  if (opts.json) {
    console.log(JSON.stringify({ repo: opts.repo ?? '', branch: opts.branch ?? null, pages: [], memories: [], estTokens: 0, markdown: '' }));
  }
}
