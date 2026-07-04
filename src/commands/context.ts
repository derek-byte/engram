import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { WikiStore } from '../wiki/store.ts';
import { buildContext } from '../context/compose.ts';
import { resolveFromCwd } from '../context/resolve.ts';

export interface ContextOptions {
  repo?: string;
  branch?: string;
  cwd?: string;
  budget?: string;
  owner?: string;
  json?: boolean;
}

const DEFAULT_BUDGET = 1500;
const MIN_BUDGET = 100;
const MAX_BUDGET = 20000;

// Emit a compact, repo-scoped context block for a new Claude Code session.
// Contract: text mode is SILENT-EMPTY (prints nothing when there's nothing
// relevant); --json always prints one parseable object. Any operational failure
// (missing config, DB down, git error) → one stderr line, empty stdout, exit 0,
// so a SessionStart hook can never inject noise or an error banner.
export async function contextCommand(opts: ContextOptions): Promise<void> {
  let backend: PgVectorBackend | null = null;
  try {
    const config = loadConfig();
    if (!configIsComplete(config)) {
      console.error('engram context: not configured yet (run engram backfill first)');
      return emitEmpty(opts);
    }

    const { repo, branch } = resolveTarget(opts);
    const owner = opts.owner ?? 'derek';
    const budgetTokens = parseBudget(opts.budget);

    backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION, {
      vectorWeight: config.vectorWeight,
      keywordWeight: config.keywordWeight,
      timeDecayHalfLifeDays: config.timeDecayHalfLifeDays,
    });
    // Read-only: skip initialize() (the ~20 DDL round-trips) to stay well under 2s.

    let store: WikiStore | null = null;
    try {
      store = new WikiStore(config.wikiDir);
    } catch {
      store = null; // display-only; excerpt fallback covers a missing wiki dir
    }

    const result = await buildContext({ repo, branch, owner, budgetTokens }, { backend, store });

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
    console.error(`engram context: ${err instanceof Error ? err.message : err}`);
    emitEmpty(opts);
  } finally {
    if (backend) await backend.close();
  }
}

function resolveTarget(opts: ContextOptions): { repo: string; branch?: string } {
  if (opts.repo) return { repo: opts.repo, branch: opts.branch };
  return resolveFromCwd(opts.cwd ?? process.cwd());
}

function parseBudget(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BUDGET;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`engram context: invalid --budget ${raw}, using ${DEFAULT_BUDGET}`);
    return DEFAULT_BUDGET;
  }
  const clamped = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.trunc(n)));
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
