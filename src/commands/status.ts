import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';

export async function statusCommand(): Promise<void> {
  const config = loadConfig();

  console.log('engram status');
  console.log('─────────────');
  console.log(`config:        ${configIsComplete(config) ? 'ok' : 'incomplete (run engram backfill)'}`);
  console.log(`openai key:    ${config.openaiApiKey ? 'set' : 'missing'}`);
  console.log(`database url:  ${config.databaseUrl ? 'set' : 'missing'}`);
  console.log(`watch path:    ${config.watchPath}`);

  const local = new LocalStore();
  const lastIngest = local.getStat('last_ingest_at');
  console.log(`last ingest:   ${lastIngest ?? 'never'}`);

  if (configIsComplete(config)) {
    const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION);
    try {
      await backend.initialize();
      const count = await backend.count();
      console.log(`chunks total:  ${count}`);
    } catch (err) {
      console.log(`chunks total:  unable to query (${err instanceof Error ? err.message : err})`);
    } finally {
      await backend.close();
    }
  }

  local.close();
}
