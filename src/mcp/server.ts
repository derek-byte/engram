import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runSearch } from '../search/index.ts';
import type { OpenAIReranker } from '../search/rerank.ts';
import type { VectorBackend } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';
import type { SearchFilters, SearchResult } from '../types/index.ts';

const CONTENT_PREVIEW_CHARS = 700;

export interface McpDeps {
  backend: VectorBackend;
  embedder: Embedder;
  reranker?: OpenAIReranker;
  rerankDefault?: boolean;
  lastIngestAt(): string | null;
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
        rerank: z.boolean().optional().describe('rerank candidates with an LLM (default from config)'),
      },
    },
    async ({ query, repo, branch, since, limit, rerank }) => {
      const sinceDate = since ? new Date(since) : undefined;
      if (sinceDate && Number.isNaN(sinceDate.getTime())) {
        throw new Error(`invalid 'since' date: ${since} (use ISO format, e.g. 2026-01-15)`);
      }
      const filters: SearchFilters = {
        repo,
        branch,
        since: sinceDate,
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
    'engram_status',
    {
      description: 'Report engram index health: total indexed chunks and last ingest time.',
      inputSchema: {},
    },
    async () => {
      const count = await deps.backend.count();
      const last = deps.lastIngestAt() ?? 'never';
      return { content: [{ type: 'text', text: `chunks: ${count}\nlast ingest: ${last}` }] };
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
      const header = `${ts} · ${m.repo}@${m.branch || '(no-branch)'} · sim=${r.similarity.toFixed(3)}${rank}`;
      return `${header}\n${preview(r.chunk.content, CONTENT_PREVIEW_CHARS)}\nsession: ${m.sessionId}`;
    })
    .join('\n\n---\n\n');
}

function preview(s: string, max: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max) + '…';
}
