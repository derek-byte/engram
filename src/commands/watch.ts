import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { SessionWatcher } from '../ingest/watcher.ts';
import { SynthesisQueue } from '../ingest/synthesisQueue.ts';

export async function watchInternalCommand(): Promise<void> {
  const config = loadConfig();
  if (!configIsComplete(config)) {
    console.error('engram is not configured. Run `engram backfill` first.');
    process.exit(1);
  }

  const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION);
  const local = new LocalStore();
  const embedder = new Embedder(buildProvider(config), backend);

  await backend.initialize();

  // Synthesis hook (dream → wiki) is gated behind the toggle + an OpenAI key so
  // today's watcher behavior is unchanged by default.
  const queue =
    config.synthesis.enabled && config.openaiApiKey
      ? new SynthesisQueue({ backend, embedder, config, owner: 'derek' })
      : undefined;
  if (queue) console.log('[watcher] synthesis hook enabled (dream → wiki after ingest)');

  const watcher = new SessionWatcher(
    { backend, local, embedder, config },
    queue ? { onIngested: (sessionId, repo) => queue.enqueue(sessionId, repo) } : undefined
  );
  watcher.start();

  const shutdown = async () => {
    console.log('\n[watcher] shutting down');
    queue?.stop();
    await watcher.stop();
    await backend.close();
    local.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
