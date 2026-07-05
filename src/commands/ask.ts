import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { runAsk, OpenAIAskLLM, AskError, demandRowForAsk, formatSourceLine } from '../ask/index.ts';
import { parseTier } from './search.ts';
import type { SearchFilters } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';

export interface AskOptions {
  repo?: string;
  branch?: string;
  since?: string;
  tier?: string;
  k?: string;
  json?: boolean;
}

// Injection seam (tests / callers with their own lifecycle). When omitted, the
// command builds these from config and closes them itself. When provided, the
// caller owns the lifecycle (nothing is closed here).
export interface AskCommandDeps {
  backend: VectorBackend;
  embedder: Embedder;
  llm: OpenAIAskLLM;
  local: LocalStore;
}

function clampK(value: string | undefined): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 12;
  return Math.min(Math.max(n, 1), 50);
}

export async function askCommand(question: string, opts: AskOptions, injected?: AskCommandDeps): Promise<void> {
  let deps = injected;
  const ownsDeps = deps === undefined;

  if (!deps) {
    const config = loadConfig();
    if (!configIsComplete(config)) {
      console.error("engram isn't configured yet. Run 'engram backfill' first.");
      process.exit(1);
    }

    // Fail fast, before any DB/embedding work: ask synthesizes an answer and
    // cannot degrade to plain retrieval, so a missing key is a hard error.
    if (!config.openaiApiKey) {
      console.error(
        `engram ask needs OPENAI_API_KEY (env or ~/.engram/config.json) — it synthesizes an answer with an LLM and cannot degrade to plain retrieval. Run: engram search "${question}" instead.`
      );
      process.exit(1);
    }

    const backend = PgVectorBackend.fromConfig(config);
    await backend.initialize();
    const embedder = new Embedder(buildProvider(config));
    const llm = new OpenAIAskLLM(config.openaiApiKey, config.wikiModel);
    const local = new LocalStore();
    deps = { backend, embedder, llm, local };
  }

  const { backend, embedder, llm, local } = deps;

  const k = clampK(opts.k);
  const filters: SearchFilters = {
    repo: opts.repo,
    branch: opts.branch,
    since: opts.since ? new Date(opts.since) : undefined,
    tier: parseTier(opts.tier),
    limit: k,
  };

  // Log the ask before the LLM call: even a failed or unanswerable ask is
  // demand signal for demand-driven synthesis (roadmap #6).
  local.logRecent('ask', question, question);

  // One demand row per ask, regardless of outcome — shared surface/query/scope.
  const demandBase = {
    surface: 'cli' as const,
    kind: 'ask' as const,
    query: question,
    tier: filters.tier ?? null,
    repo: opts.repo ?? null,
  };

  try {
    const result = await runAsk(question, filters, { backend, embedder, llm });

    // Demand logging must never take down a paid, successful ask.
    try {
      local.logDemand(demandRowForAsk('cli', question, filters.tier ?? null, opts.repo ?? null, result));
    } catch {
      /* demand log is telemetry */
    }

    if (opts.json) {
      console.log(JSON.stringify({ answer: result.answer, sources: result.sources, usage: result.usage }, null, 2));
    } else if (result.answer === null) {
      console.log(`No indexed material matched. Try: engram search "${question}" --tier all`);
    } else {
      console.log(result.answer);
      const cited = result.sources.filter((s) => s.cited);
      console.log('');
      if (cited.length === 0) {
        console.log(`(${result.sources.length} candidates retrieved, none cited — try engram search "${question}")`);
      } else {
        console.log('Sources:');
        for (const s of cited) console.log(formatSourceLine(s));
      }
    }

    // Diagnostics to stderr so stdout stays clean prose / jq-safe JSON.
    if (result.usage) {
      const p = (result.usage.promptTokens / 1000).toFixed(1);
      console.error(`[ask] ${result.model} · ${p}k prompt + ${result.usage.completionTokens} completion tokens`);
    }
  } catch (err) {
    if (err instanceof AskError) {
      // A failed ask is still demand — record it with the 'error' outcome
      // (no AskResult exists here, so the top_* fields stay null).
      try {
        local.logDemand({ ...demandBase, outcome: 'error' });
      } catch {
        /* demand log is telemetry */
      }
      console.error(`engram ask failed: ${err.message}. Run: engram search "${question}" instead.`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    if (ownsDeps) {
      await backend.close();
      local.close();
    }
  }
}
