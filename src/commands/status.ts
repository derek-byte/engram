import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { WikiStore } from '../wiki/store.ts';

export async function statusCommand(): Promise<void> {
  const config = loadConfig();

  console.log('engram status');
  console.log('─────────────');
  console.log(`config:        ${configIsComplete(config) ? 'ok' : 'incomplete (run engram backfill)'}`);
  console.log(`openai key:    ${config.openaiApiKey ? 'set' : 'missing'}`);
  console.log(`embedding:     ${config.embeddingProvider} · ${config.embeddingModel} (${config.embeddingDim}d)`);
  console.log(`database url:  ${config.databaseUrl ? 'set' : 'missing'}`);
  console.log(`watch path:    ${config.watchPath}`);

  console.log(`synthesis:     ${config.synthesis.enabled ? `on (nightly ${String(config.synthesis.hour).padStart(2, '0')}:00)` : 'off'}`);

  const local = new LocalStore();
  const lastIngest = local.getStat('last_ingest_at');
  console.log(`last ingest:   ${lastIngest ?? 'never'}`);

  try {
    const pages = new WikiStore(config.wikiDir).listSlugs().length;
    console.log(`wiki pages:    ${pages} (${config.wikiDir})`);
  } catch {
    console.log(`wiki pages:    unavailable`);
  }

  if (configIsComplete(config)) {
    const backend = PgVectorBackend.fromConfig(config);
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
