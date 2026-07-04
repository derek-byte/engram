import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runSearch } from '../search/index.ts';
import { runAsk, OpenAIAskLLM, AskError, formatSourceLine } from '../ask/index.ts';
import type { OpenAIReranker } from '../search/rerank.ts';
import type { VectorBackend } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';
import type { SearchFilters, SearchResult } from '../types/index.ts';
import type { WikiStore } from '../wiki/store.ts';
import { serializePage } from '../wiki/store.ts';

const CONTENT_PREVIEW_CHARS = 700;

export interface McpDeps {
  backend: VectorBackend;
  embedder: Embedder;
  reranker?: OpenAIReranker;
  rerankDefault?: boolean;
  lastIngestAt(): string | null;
  store?: WikiStore;
  askLLM?: OpenAIAskLLM;
  logRecent?(kind: string, key: string, label: string): void;
}

function parseTier(value: string | undefined): SearchFilters['tier'] {
  if (value === 'raw' || value === 'dream' || value === 'wiki' || value === 'synth' || value === 'all') return value;
  return 'synth';
}

export async function startMcpServer(deps: McpDeps): Promise<void> {
  const server = new McpServer({ name: 'engram', version: '0.1.0' });

  server.registerTool(
    'engram_search',
    {
      description:
        "Search Derek's past Claude Code sessions — decisions, fixes, and discussions from all projects.",
      inputSchema: {
        query: z.string().describe('natural-language query'),
        repo: z.string().optional().describe('limit to a repo name'),
        branch: z.string().optional().describe('limit to a git branch'),
        since: z.string().optional().describe('only results after this ISO date'),
        limit: z.number().int().positive().optional().describe('max results (default 5)'),
        tier: z.enum(['raw', 'dream', 'wiki', 'synth', 'all']).optional().describe("which memory tiers to search (default 'synth' = wiki+dream; 'raw' for verbatim drill-down)"),
        rerank: z.boolean().optional().describe('rerank candidates with an LLM (default from config)'),
      },
    },
    async ({ query, repo, branch, since, limit, tier, rerank }) => {
      const sinceDate = since ? new Date(since) : undefined;
      if (sinceDate && Number.isNaN(sinceDate.getTime())) {
        throw new Error(`invalid 'since' date: ${since} (use ISO format, e.g. 2026-01-15)`);
      }
      const filters: SearchFilters = {
        repo,
        branch,
        since: sinceDate,
        tier: parseTier(tier),
        limit: limit ?? 5,
      };
      const useRerank = rerank ?? deps.rerankDefault ?? false;
      if (useRerank && !deps.reranker) {
        console.error('[rerank] requested but no OPENAI_API_KEY; falling back to hybrid order');
      }
      const results = await runSearch(query, filters, {
        backend: deps.backend,
        embedder: deps.embedder,
        reranker: useRerank ? deps.reranker : undefined,
      });
      return { content: [{ type: 'text', text: formatResults(results) }] };
    }
  );

  server.registerTool(
    'engram_ask',
    {
      description:
        "Ask Derek's coding memory a question and get ONE synthesized, citation-backed answer (wiki/dream tiers; costs an LLM call, ~5–20s). Use when you want a conclusion — 'what did we decide about X and why' — rather than raw excerpts; use engram_search when you want the underlying material or need zero-latency lookup. Says plainly when memory doesn't cover the question.",
      inputSchema: {
        question: z.string().describe('natural-language question'),
        repo: z.string().optional().describe('limit to a repo name'),
        limit: z.number().int().positive().max(50).optional().describe('retrieval candidates fed to the answer model (default 12, max 50)'),
      },
    },
    async ({ question, repo, limit }) => {
      deps.logRecent?.('ask', question, question);
      if (!deps.askLLM) {
        return {
          content: [{ type: 'text', text: 'engram_ask unavailable: no OPENAI_API_KEY. Use engram_search instead.' }],
          isError: true,
        };
      }
      try {
        const result = await runAsk(
          question,
          { repo, tier: 'synth', limit: limit ?? 12 },
          { backend: deps.backend, embedder: deps.embedder, llm: deps.askLLM }
        );
        if (result.answer === null) {
          return { content: [{ type: 'text', text: 'No indexed material matched.' }] };
        }
        const cited = result.sources.filter((s) => s.cited);
        const sourcesText = cited.length > 0 ? cited.map(formatSourceLine).join('\n') : '(no sources cited)';
        return { content: [{ type: 'text', text: `${result.answer}\n\n---\n${sourcesText}` }] };
      } catch (err) {
        const reason = err instanceof AskError ? err.message : err instanceof Error ? err.message : String(err);
        console.error(`[ask] ${reason}`);
        return {
          content: [{ type: 'text', text: `engram_ask failed: ${reason}. Use engram_search instead.` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'engram_wiki_page',
    {
      description: 'Fetch one compiled wiki page by slug — the full markdown with frontmatter provenance (drill-down from a wiki search hit).',
      inputSchema: { slug: z.string().describe('the page slug, e.g. from a [wiki:...] search hit') },
    },
    async ({ slug }) => {
      if (!deps.store) return { content: [{ type: 'text', text: 'wiki is not available.' }] };
      let page;
      try {
        page = deps.store.readPage(slug);
      } catch (err) {
        return { content: [{ type: 'text', text: `page ${slug}: ${err instanceof Error ? err.message : err}` }] };
      }
      if (!page) return { content: [{ type: 'text', text: `no wiki page: ${slug}` }] };
      return { content: [{ type: 'text', text: serializePage(page) }] };
    }
  );

  server.registerTool(
    'engram_status',
    {
      description: 'Report engram index health: total indexed chunks, wiki page count, and last ingest time.',
      inputSchema: {},
    },
    async () => {
      const count = await deps.backend.count();
      const last = deps.lastIngestAt() ?? 'never';
      const pages = deps.store ? deps.store.listSlugs().length : 0;
      return { content: [{ type: 'text', text: `chunks: ${count}\nwiki pages: ${pages}\nlast ingest: ${last}` }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.';
  return results
    .map((r) => {
      const m = r.chunk.metadata;
      const ts = m.timestamp instanceof Date ? m.timestamp.toISOString() : String(m.timestamp);
      const rank = r.rerankRank !== undefined ? ` · rank=#${r.rerankRank}` : '';
      if (m.tier === 'wiki') {
        const slug = m.trajectoryId?.replace(/^wiki:/, '') ?? '?';
        const prov = m.sourceChunkIds?.length ?? 0;
        const header = `[wiki:${m.dreamType ?? '?'}] ${slug} · sim=${r.similarity.toFixed(3)}${rank}`;
        return `${header}\n${preview(r.chunk.content, CONTENT_PREVIEW_CHARS)}\npage: ${slug} · provenance: ${prov} dream chunks (engram_wiki_page slug=${slug})`;
      }
      const tierTag = m.tier === 'dream' ? `[dream:${m.dreamType ?? '?'}] ` : '';
      const header = `${tierTag}${ts} · ${m.repo}@${m.branch || '(no-branch)'} · sim=${r.similarity.toFixed(3)}${rank}`;
      return `${header}\n${preview(r.chunk.content, CONTENT_PREVIEW_CHARS)}\nsession: ${m.sessionId}`;
    })
    .join('\n\n---\n\n');
}

function preview(s: string, max: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max) + '…';
}
