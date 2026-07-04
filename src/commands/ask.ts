import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { runAsk, OpenAIAskLLM, AskError, formatSourceLine } from '../ask/index.ts';
import { parseTier } from './search.ts';
import type { SearchFilters } from '../types/index.ts';

export interface AskOptions {
  repo?: string;
  branch?: string;
  since?: string;
  tier?: string;
  k?: string;
  json?: boolean;
}

function clampK(value: string | undefined): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 12;
  return Math.min(Math.max(n, 1), 50);
}

export async function askCommand(question: string, opts: AskOptions): Promise<void> {
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

  const k = clampK(opts.k);
  const filters: SearchFilters = {
    repo: opts.repo,
    branch: opts.branch,
    since: opts.since ? new Date(opts.since) : undefined,
    tier: parseTier(opts.tier),
    limit: k,
  };

  const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION, {
    vectorWeight: config.vectorWeight,
    keywordWeight: config.keywordWeight,
    timeDecayHalfLifeDays: config.timeDecayHalfLifeDays,
  });
  await backend.initialize();
  const embedder = new Embedder(buildProvider(config));
  const llm = new OpenAIAskLLM(config.openaiApiKey, config.wikiModel);
  const local = new LocalStore();

  // Log the ask before the LLM call: even a failed or unanswerable ask is
  // demand signal for demand-driven synthesis (roadmap #6).
  local.logRecent('ask', question, question);

  try {
    const result = await runAsk(question, filters, { backend, embedder, llm });

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
      console.error(`engram ask failed: ${err.message}. Run: engram search "${question}" instead.`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    await backend.close();
    local.close();
  }
}
