import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { OpenAIDreamLLM } from '../dream/llm.ts';
import { OpenAIWikiLLM } from '../wiki/llm.ts';
import { synthesizeDreams } from '../dream/synthesize.ts';
import { ingestWiki } from '../wiki/ingest.ts';
import { WikiStore } from '../wiki/store.ts';
import { acquireSynthesisLock } from './synthesisLock.ts';

const OVERLAP_MS = 24 * 60 * 60 * 1000;

function log(phase: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), phase, ...data }));
}

// Hidden headless command: dream synthesis → wiki ingest, end to end. Launchd
// nightly agent + watcher hook target. Fully non-interactive, one JSON line/phase.
export async function synthesisRunCommand(): Promise<void> {
  const config = loadConfig();
  if (!configIsComplete(config) || !config.openaiApiKey) {
    log('error', { message: 'not configured or missing OPENAI_API_KEY' });
    process.exit(1);
  }

  const lock = acquireSynthesisLock();
  if (!lock) {
    log('skipped', { reason: 'locked' });
    return;
  }

  const owner = 'derek';
  const local = new LocalStore();
  const lastRun = local.getStat('last_synthesis_at');
  const since = lastRun ? new Date(new Date(lastRun).getTime() - OVERLAP_MS) : undefined;

  const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION, {
    vectorWeight: config.vectorWeight,
    keywordWeight: config.keywordWeight,
    timeDecayHalfLifeDays: config.timeDecayHalfLifeDays,
  });

  try {
    await backend.initialize();
    const embedder = new Embedder(buildProvider(config), backend);

    const dream = await synthesizeDreams(
      { sourceOwner: owner, dreamOwner: owner, since, limit: 1000, dryRun: false },
      { backend, embedder, llm: new OpenAIDreamLLM(config.openaiApiKey, config.dreamModel), config }
    );
    log('dream', { synthesized: dream.synthesized, dreamChunks: dream.dreamChunks, skipped: dream.skipped, failed: dream.failed });

    const store = new WikiStore(config.wikiDir);
    const wiki = await ingestWiki(
      { sourceOwner: owner, wikiOwner: owner, limit: 1000, dryRun: false },
      { backend, store, embedder, llm: new OpenAIWikiLLM(config.openaiApiKey, config.wikiModel), config }
    );
    log('wiki', {
      unitsCompiled: wiki.unitsCompiled,
      pagesCreated: wiki.pagesCreated,
      pagesUpdated: wiki.pagesUpdated,
      failed: wiki.failed,
    });

    // Stamp only after both phases complete (overlap is free — fingerprints skip).
    const now = new Date().toISOString();
    local.setStat('last_synthesis_at', now);
    local.setStat('last_wiki_ingest_at', now);
    log('done', {});
  } catch (err) {
    log('error', { message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    lock.release();
    local.close();
    await backend.close();
  }
}
