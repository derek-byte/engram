import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { WikiStore } from '../wiki/store.ts';
import { isValidSlug } from '../wiki/links.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { runSearch } from '../search/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
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

export interface UiDeps {
  html: string;
  backend: VectorBackend;
  embedder: Embedder;
  local: LocalStore;
  wiki: WikiStore;
  dim: number;
  port: number;
}

// The full request handler, extracted from Bun.serve so route tests can call it
// with Request objects directly (no port bind, no network) — same seam
// philosophy as service.ts's exported buildPlist. uiCommand is a thin wire-up.
export function buildUiFetch(deps: UiDeps): (req: Request) => Promise<Response> {
  const { html, backend, embedder, local, wiki, dim, port } = deps;

  // DNS-rebinding defense: only loopback Host values are legitimate for this
  // server. A malicious site rebound to 127.0.0.1 arrives with its own Host,
  // so anything else gets rejected before touching the index. Browser requests
  // carrying a foreign Origin are rejected for the same reason.
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  return async function fetch(req: Request): Promise<Response> {
    const host = req.headers.get('host');
    if (!host || !allowedHosts.has(host.toLowerCase())) {
      return new Response('forbidden', { status: 403 });
    }
    const origin = req.headers.get('origin');
    if (origin && !allowedOrigins.has(origin.toLowerCase())) {
      return new Response('forbidden', { status: 403 });
    }

    const url = new URL(req.url);

    if (url.pathname === '/') {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/api/stats') {
      try {
        const chunks = await backend.count();
        return Response.json({ model: embedder.model, dim, chunks });
      } catch (err) {
        console.error('stats failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'stats failed' }, { status: 500 });
      }
    }

    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q')?.trim() ?? '';
      if (!q) return Response.json([]);
      const kRaw = Math.floor(Number(url.searchParams.get('k') ?? '3'));
      const k = Number.isFinite(kRaw) ? Math.min(50, Math.max(1, kRaw)) : 3;
      const tierRaw = url.searchParams.get('tier');
      const tier: SearchFilters['tier'] =
        tierRaw === 'raw' || tierRaw === 'dream' || tierRaw === 'wiki' || tierRaw === 'synth' || tierRaw === 'all'
          ? tierRaw
          : 'synth';
      const filters: SearchFilters = { limit: k, tier };
      try {
        const results = await runSearch(q, filters, { backend, embedder });
        // Cosmetic usage log; never let a failure break search. Only meaningful
        // queries (>=3 chars, with hits) are logged; consecutive-identical /
        // prefix-refinement dedupe lives in LocalStore.logRecent.
        if (q.length >= 3 && results.length > 0) {
          try {
            local.logRecent('search', q, q);
          } catch {
            /* recents are cosmetic */
          }
        }
        return Response.json(
          results.map((r) => {
            const m = r.chunk.metadata;
            const slug = m.tier === 'wiki' ? (m.trajectoryId?.replace(/^wiki:/, '') ?? null) : null;
            return {
              id: r.chunk.id,
              similarity: r.similarity,
              repo: m.repo,
              branch: m.branch,
              timestamp: m.timestamp,
              sessionId: m.sessionId,
              tier: m.tier,
              kind: m.dreamType ?? null,
              slug,
              sources: m.sourceChunkIds ?? [],
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

    const wikiMatch = url.pathname.match(/^\/api\/wiki\/(.+)$/);
    if (wikiMatch) {
      let slug: string;
      try {
        slug = decodeURIComponent(wikiMatch[1]!);
      } catch {
        return Response.json({ error: 'bad slug' }, { status: 400 });
      }
      // Slug validation doubles as the path-traversal guard: pagePath is only
      // ever reached with a validated kebab-case slug.
      if (!isValidSlug(slug)) return Response.json({ error: 'bad slug' }, { status: 400 });
      let page;
      try {
        page = wiki.readPage(slug);
      } catch (err) {
        console.error('wiki read failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'read failed' }, { status: 500 });
      }
      if (!page) return Response.json({ error: 'not found' }, { status: 404 });
      try {
        local.logRecent('view', 'wiki:' + slug, page.title);
      } catch {
        /* recents are cosmetic */
      }
      return Response.json({
        slug: page.slug,
        title: page.title,
        kind: page.kind,
        summary: page.summary,
        updated: page.updated,
        created: page.created,
        sourceCount: page.sources.length,
        trajectoryId: 'wiki:' + slug,
        body: page.body,
      });
    }

    if (url.pathname === '/api/recents') {
      try {
        return Response.json(local.getRecents(50));
      } catch (err) {
        console.error('recents failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'recents failed' }, { status: 500 });
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
        // Log raw/dream trajectory opens as views; wiki drill-downs are excluded
        // because the page view already logged 'wiki:<slug>'.
        if (chunks.length > 0 && !trajectoryId.startsWith('wiki:')) {
          const m = chunks[0]!.metadata;
          try {
            local.logRecent('view', 'traj:' + trajectoryId, (m.repo ?? '(no-repo)') + '@' + (m.branch ?? 'no-branch'));
          } catch {
            /* recents are cosmetic */
          }
        }
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
  };
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
  const embedder = new Embedder(buildProvider(config), backend);
  const local = new LocalStore();
  const wiki = new WikiStore(config.wikiDir);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: buildUiFetch({ html, backend, embedder, local, wiki, dim: config.embeddingDim, port }),
  });

  console.log(`engram ui → http://${server.hostname}:${server.port}`);
}
