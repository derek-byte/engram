import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { startMcpServer } from '../mcp/server.ts';
import { buildReranker } from '../search/rerank.ts';

export async function mcpCommand(): Promise<void> {
  const config = loadConfig();
  if (!configIsComplete(config)) {
    console.error("engram isn't configured yet. Run 'engram backfill' first.");
    process.exit(1);
  }

  const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION);
  await backend.initialize();
  const embedder = new Embedder(buildProvider(config), backend);
  const local = new LocalStore();

  await startMcpServer({
    backend,
    embedder,
    reranker: config.openaiApiKey ? buildReranker(config) : undefined,
    rerankDefault: config.rerank.enabled,
    lastIngestAt: () => local.getStat('last_ingest_at'),
  });
}
