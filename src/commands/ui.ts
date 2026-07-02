import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { Embedder } from '../ingest/embed.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { runSearch } from '../search/index.ts';
import type { SearchFilters } from '../types/index.ts';

const SNIPPET_CHARS = 300;
const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');

export interface UiOptions {
  port?: string;
}

function snippet(s: string): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length <= SNIPPET_CHARS ? cleaned : cleaned.slice(0, SNIPPET_CHARS) + '…';
}

export async function uiCommand(opts: UiOptions): Promise<void> {
  const config = loadConfig();
  if (!configIsComplete(config)) {
    console.error("engram isn't configured yet. Run 'engram backfill' first.");
    process.exit(1);
  }

  const port = opts.port ? Number(opts.port) : 7777;
  const html = readFileSync(HTML_PATH, 'utf-8');

  const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION);
  await backend.initialize();
  // Pass the backend as the embedding cache so repeat queries hit embedding_cache (free).
  const embedder = new Embedder(config.openaiApiKey, config.embeddingModel, backend);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/') {
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      if (url.pathname === '/api/search') {
        const q = url.searchParams.get('q')?.trim() ?? '';
        if (!q) return Response.json([]);
        const kRaw = Math.floor(Number(url.searchParams.get('k') ?? '3'));
        const k = Number.isFinite(kRaw) ? Math.min(50, Math.max(1, kRaw)) : 3;
        const filters: SearchFilters = { limit: k };
        try {
          const results = await runSearch(q, filters, { backend, embedder });
          return Response.json(
            results.map((r) => {
              const m = r.chunk.metadata;
              return {
                id: r.chunk.id,
                similarity: r.similarity,
                repo: m.repo,
                branch: m.branch,
                timestamp: m.timestamp,
                sessionId: m.sessionId,
                trajectoryId: m.trajectoryId ?? null,
                chunkIndex: m.chunkIndex ?? null,
                snippet: snippet(r.chunk.content),
              };
            })
          );
        } catch (err) {
          console.error('search failed:', err instanceof Error ? err.message : err);
          return Response.json({ error: 'search failed' }, { status: 500 });
        }
      }

      const traj = url.pathname.match(/^\/api\/trajectory\/(.+)$/);
      if (traj) {
        let trajectoryId: string;
        try {
          trajectoryId = decodeURIComponent(traj[1]!);
        } catch {
          return Response.json({ error: 'bad trajectory id' }, { status: 400 });
        }
        try {
          const chunks = await backend.getTrajectory(trajectoryId);
          return Response.json(
            chunks.map((c) => ({
              id: c.id,
              chunkIndex: c.metadata.chunkIndex ?? null,
              chunkCount: c.metadata.chunkCount ?? null,
              content: c.content,
              repo: c.metadata.repo,
              branch: c.metadata.branch,
              timestamp: c.metadata.timestamp,
              sessionId: c.metadata.sessionId,
            }))
          );
        } catch (err) {
          console.error('trajectory fetch failed:', err instanceof Error ? err.message : err);
          return Response.json({ error: 'fetch failed' }, { status: 500 });
        }
      }

      return new Response('not found', { status: 404 });
    },
  });

  console.log(`engram ui → http://${server.hostname}:${server.port}`);
}
