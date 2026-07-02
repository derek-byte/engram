import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { SessionWatcher } from '../ingest/watcher.ts';

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

  const watcher = new SessionWatcher({ backend, local, embedder, config });
  watcher.start();

  const shutdown = async () => {
    console.log('\n[watcher] shutting down');
    await watcher.stop();
    await backend.close();
    local.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
