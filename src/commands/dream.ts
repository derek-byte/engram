import { loadConfig, configIsComplete, DEFAULT_OWNER } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { OpenAIDreamLLM } from '../dream/llm.ts';
import { synthesizeDreams, type UnitPlan } from '../dream/synthesize.ts';

export interface DreamOptions {
  repo?: string;
  since?: string;
  limit?: string;
  owner?: string;
  dreamOwner?: string;
  dryRun?: boolean;
  json?: boolean;
}

export async function dreamCommand(opts: DreamOptions): Promise<void> {
  const config = loadConfig();
  if (!configIsComplete(config)) {
    console.error("engram isn't configured yet. Run 'engram backfill' first.");
    process.exit(1);
  }

  // A dream layer cannot be synthesized without a chat model — no fallback latch.
  if (!opts.dryRun && !config.openaiApiKey) {
    console.error('engram dream needs an OpenAI API key (set OPENAI_API_KEY) to call the chat model.');
    process.exit(1);
  }

  const since = opts.since ? new Date(opts.since) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    console.error(`invalid '--since' date: ${opts.since} (use ISO format, e.g. 2026-01-15)`);
    process.exit(1);
  }

  const parsedLimit = opts.limit ? Number(opts.limit) : 20;
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.floor(parsedLimit)) : 20;

  const sourceOwner = opts.owner ?? DEFAULT_OWNER;
  const dreamOwner = opts.dreamOwner ?? sourceOwner;

  const backend = PgVectorBackend.fromConfig(config);
  await backend.initialize();
  const embedder = new Embedder(buildProvider(config), backend);
  const llm = new OpenAIDreamLLM(config.openaiApiKey, config.dreamModel);

  try {
    const result = await synthesizeDreams(
      { sourceOwner, dreamOwner, repo: opts.repo, since, limit, dryRun: Boolean(opts.dryRun) },
      { backend, embedder, llm, config }
    );

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.dryRun) {
      printPlan(result.plan ?? [], result.estTotalTokens ?? 0, result.skipped, result.deferred, config.dreamModel);
    } else {
      console.log(
        `synthesized ${result.synthesized} units (${result.dreamChunks} dream chunks, ${result.emptyUnits} empty), ` +
          `skipped ${result.skipped} unchanged, deferred ${result.deferred}, failed ${result.failed}`
      );
      console.log(`tokens: ${result.promptTokens} prompt, ${result.completionTokens} completion`);
    }
  } finally {
    await backend.close();
  }
}

function printPlan(plan: UnitPlan[], estTotal: number, skipped: number, deferred: number, model: string): void {
  if (plan.length === 0) {
    console.log(`Nothing to synthesize (${skipped} unchanged, ${deferred} deferred).`);
    return;
  }
  console.log(`Would synthesize ${plan.length} unit(s) with ${model} (${skipped} unchanged, ${deferred} deferred):\n`);
  for (const p of plan) {
    console.log(
      `  [${p.status}] ${p.sessionId.slice(0, 12)} · ${p.repo || '(no repo)'} · ${p.chunks} chunks · ~${p.estTokens} tokens`
    );
  }
  console.log(`\nEstimated total input: ~${estTotal} tokens.`);
}
