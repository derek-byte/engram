import type { Chunk, EngramConfig } from '../types/index.ts';
import type { DreamStore, SynthesisUnit, VectorBackend, WikiLedger, WikiUnitRow } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';
import type { WikiIngestLLM } from './llm.ts';
import { chunkHash } from '../ingest/hash.ts';
import { CHARS_PER_TOKEN } from '../ingest/chunker.ts';
import { fingerprintOf } from '../dream/synthesize.ts';
import { WikiStore, pageFingerprint, type WikiPage } from './store.ts';
import { buildUnitHeader, buildItemsText, buildCandidatesText, type DreamItemInput } from './prompt.ts';

// A page body under this many chars stays one chunk; larger pages split on ##.
const SINGLE_CHUNK_BUDGET = 1000 * CHARS_PER_TOKEN;
const SHRINK_FLOOR = 0.4; // reject an update whose body drops below 40% of old…
const SHRINK_MIN_OLD = 500; // …when the old body was more than 500 chars.
const CANDIDATES_PER_ITEM = 5;
const MAX_CANDIDATE_PAGES = 8;

export interface WikiIngestParams {
  sourceOwner: string; // owner whose dream chunks are compiled
  wikiOwner: string; // owner the wiki pg chunks are written under
  repo?: string;
  since?: Date;
  limit: number;
  dryRun: boolean;
}

export type WikiBackend = DreamStore &
  WikiLedger &
  Pick<VectorBackend, 'search' | 'upsert' | 'getTrajectory' | 'insertRawEvents'>;

export interface WikiIngestDeps {
  backend: WikiBackend;
  store: WikiStore;
  embedder: Embedder;
  llm: WikiIngestLLM;
  config: EngramConfig;
}

export interface WikiUnitPlan {
  sessionId: string;
  repo: string;
  items: number;
  estTokens: number;
  status: 'new' | 'changed';
}

export interface WikiIngestResult {
  unitsCompiled: number;
  pagesCreated: number;
  pagesUpdated: number;
  pagesSkippedGuard: number;
  unitsSkipped: number;
  deferred: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  dryRun: boolean;
  plan?: WikiUnitPlan[];
  estTotalTokens?: number;
}

function unitKey(sessionId: string, repo: string): string {
  return `${sessionId}\n${repo}`;
}

export async function ingestWiki(params: WikiIngestParams, deps: WikiIngestDeps): Promise<WikiIngestResult> {
  const { backend, store, embedder, llm, config } = deps;
  store.init();

  const units = await backend.listDreamUnitsAsUnits(params.sourceOwner, { repo: params.repo, since: params.since });

  const existing = new Map<string, WikiUnitRow>();
  for (const row of await backend.getWikiUnits(params.wikiOwner)) {
    existing.set(unitKey(row.sessionId, row.repo), row);
  }

  let unitsSkipped = 0;
  const pending: Array<{ unit: SynthesisUnit; fingerprint: string; status: 'new' | 'changed' }> = [];
  for (const unit of units) {
    const fingerprint = fingerprintOf(unit);
    const prior = existing.get(unitKey(unit.sessionId, unit.repo));
    if (prior && prior.fingerprint === fingerprint) {
      unitsSkipped++;
      continue;
    }
    pending.push({ unit, fingerprint, status: prior ? 'changed' : 'new' });
  }

  const toProcess = pending.slice(0, Math.max(0, params.limit));
  const deferred = pending.length - toProcess.length;
  const capChars = config.wikiMaxInputChars;

  if (params.dryRun) {
    const plan: WikiUnitPlan[] = toProcess.map(({ unit, status }) => ({
      sessionId: unit.sessionId,
      repo: unit.repo,
      items: unit.chunkIds.length,
      estTokens: Math.ceil(Math.min(unit.totalChars, capChars) / CHARS_PER_TOKEN),
      status,
    }));
    return {
      unitsCompiled: 0,
      pagesCreated: 0,
      pagesUpdated: 0,
      pagesSkippedGuard: 0,
      unitsSkipped,
      deferred,
      failed: 0,
      promptTokens: 0,
      completionTokens: 0,
      dryRun: true,
      plan,
      estTotalTokens: plan.reduce((s, p) => s + p.estTokens, 0),
    };
  }

  let unitsCompiled = 0;
  let pagesCreated = 0;
  let pagesUpdated = 0;
  let pagesSkippedGuard = 0;
  let failed = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const touched = new Set<string>();

  for (const { unit, fingerprint } of toProcess) {
    try {
      const dreamChunks = await backend.getUnitChunks(params.sourceOwner, unit.sessionId, unit.repo, 'dream');
      const items: DreamItemInput[] = dreamChunks.map((c) => ({
        id: c.id,
        kind: c.metadata.dreamType ?? 'note',
        text: c.content,
      }));
      if (items.length === 0) {
        await backend.upsertWikiUnit(ledgerRow(params, unit, fingerprint, [], config));
        unitsCompiled++;
        continue;
      }

      const candidates = await discoverCandidates(items, params.wikiOwner, deps);
      const { pages: ops, usage } = await llm.ingest(
        buildUnitHeader(unit),
        buildItemsText(items),
        buildCandidatesText(candidates, capChars),
        store.inventory()
      );
      if (usage) {
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
      }

      const trajectoryId = `dream:${fingerprint}`;
      const now = new Date().toISOString();
      const pagesForUnit: string[] = [];

      for (const op of ops) {
        const existingPage = store.readPage(op.slug);
        // Shrink guard: reject a rewrite that collapses a substantial page.
        if (
          existingPage &&
          existingPage.body.length > SHRINK_MIN_OLD &&
          op.body.length < existingPage.body.length * SHRINK_FLOOR
        ) {
          pagesSkippedGuard++;
          console.warn(
            `[wiki] shrink guard: ${op.slug} update ${op.body.length} < 40% of ${existingPage.body.length} chars — keeping old page`
          );
          continue;
        }

        const sources = mergeUnique(existingPage?.sources ?? [], op.sources);
        const trajectories = mergeUnique(existingPage?.trajectories ?? [], [trajectoryId]);
        const page: WikiPage = {
          slug: op.slug,
          schema: existingPage?.schema ?? 1,
          title: op.title,
          kind: op.kind,
          summary: op.summary,
          aliases: mergeUnique(existingPage?.aliases ?? [], op.aliases),
          sources,
          trajectories,
          fingerprint: pageFingerprint(sources),
          created: existingPage?.created || now,
          updated: now,
          body: op.body,
        };
        store.writePage(page);
        await syncPageToIndex(page, params.wikiOwner, deps);
        touched.add(op.slug);
        pagesForUnit.push(op.slug);
        if (existingPage) pagesUpdated++;
        else pagesCreated++;
      }

      // Ledger written LAST: a mid-unit failure leaves it unrecorded so the unit
      // retries next run; page writes + pg sync are idempotent-by-content.
      await backend.upsertWikiUnit(ledgerRow(params, unit, fingerprint, pagesForUnit, config));
      unitsCompiled++;
    } catch (err) {
      failed++;
      console.error(
        `[wiki] unit ${unit.sessionId}@${unit.repo || '(no repo)'} failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  if (touched.size > 0) {
    store.renderIndex();
    store.commit(`wiki ingest: ${unitsCompiled} unit(s), ${touched.size} page(s)`);
  }

  return {
    unitsCompiled,
    pagesCreated,
    pagesUpdated,
    pagesSkippedGuard,
    unitsSkipped,
    deferred,
    failed,
    promptTokens,
    completionTokens,
    dryRun: false,
  };
}

function ledgerRow(
  params: WikiIngestParams,
  unit: SynthesisUnit,
  fingerprint: string,
  pages: string[],
  config: EngramConfig
): WikiUnitRow {
  return {
    owner: params.wikiOwner,
    sessionId: unit.sessionId,
    repo: unit.repo,
    fingerprint,
    sourceChunkIds: unit.chunkIds,
    pages,
    model: config.wikiModel,
  };
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

// Candidate neighbour pages: embed each dream item, search tier='wiki' (exhaustive
// — the wiki tier is small and owner-filtered, so HNSW would starve), plus verbatim
// title/alias matches over the inventory. Capped at MAX_CANDIDATE_PAGES.
async function discoverCandidates(
  items: DreamItemInput[],
  wikiOwner: string,
  deps: WikiIngestDeps
): Promise<WikiPage[]> {
  const { backend, store, embedder } = deps;
  const slugs = new Set<string>();

  const vectors = await embedder.embed(
    items.map((it) => it.text),
    items.map((it) => `wiki-candidate:${it.id}`)
  );
  for (let i = 0; i < items.length; i++) {
    const hits = await backend.search(vectors[i]!, items[i]!.text, {
      owner: wikiOwner,
      tier: 'wiki',
      exhaustive: true,
      limit: CANDIDATES_PER_ITEM,
    });
    for (const h of hits) {
      const t = h.chunk.metadata.trajectoryId;
      if (t?.startsWith('wiki:')) slugs.add(t.slice('wiki:'.length));
    }
  }

  // Verbatim title/alias matches over the current inventory.
  const allPages = store.listPages();
  const haystack = items.map((it) => it.text.toLowerCase());
  for (const p of allPages) {
    const needles = [p.title, ...p.aliases].map((s) => s.toLowerCase()).filter((s) => s.length >= 3);
    if (needles.some((n) => haystack.some((h) => h.includes(n)))) slugs.add(p.slug);
  }

  const out: WikiPage[] = [];
  for (const slug of slugs) {
    if (out.length >= MAX_CANDIDATE_PAGES) break;
    const p = store.readPage(slug);
    if (p) out.push(p);
  }
  return out;
}

// Split a page body into chunk texts: one chunk unless it exceeds the budget, in
// which case split on ## headings.
export function pageToChunkTexts(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed.length <= SINGLE_CHUNK_BUDGET) return [trimmed];
  const parts: string[] = [];
  let buf: string[] = [];
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('## ') && buf.length > 0) {
      parts.push(buf.join('\n').trim());
      buf = [];
    }
    buf.push(line);
  }
  if (buf.length > 0) parts.push(buf.join('\n').trim());
  return parts.filter((p) => p.length > 0);
}

// Embed a page and reconcile pg tier='wiki' chunks: upsert the new content-addressed
// id set (unchanged content is free via ON CONFLICT), delete old−new.
export async function syncPageToIndex(
  page: WikiPage,
  wikiOwner: string,
  deps: Pick<WikiIngestDeps, 'backend' | 'embedder'>
): Promise<void> {
  const { backend, embedder } = deps;
  const trajectoryId = `wiki:${page.slug}`;
  const texts = pageToChunkTexts(page.body);
  const { embeddings, model } = await embedder.embedWithStats(
    texts,
    texts.map((_, i) => `${trajectoryId}#${i}`)
  );
  const ts = page.updated ? new Date(page.updated) : new Date();
  const chunks: Chunk[] = texts.map((text, i) => ({
    id: chunkHash(trajectoryId, i, text),
    embedding: embeddings[i]!,
    content: text,
    metadata: {
      repo: '',
      branch: '',
      timestamp: Number.isNaN(ts.getTime()) ? new Date() : ts,
      filePaths: [],
      exitCode: null,
      sessionId: '',
      cwd: '',
      tier: 'wiki',
      dreamType: page.kind,
      owner: wikiOwner,
      trajectoryId,
      chunkIndex: i,
      chunkCount: texts.length,
      sourceChunkIds: page.sources,
      embeddingModel: model,
    },
  }));
  const newIds = new Set(chunks.map((c) => c.id));
  await backend.upsert(chunks);

  const current = await backend.getTrajectory(trajectoryId);
  const stale = current.map((c) => c.id).filter((id) => !newIds.has(id));
  await backend.deleteChunksByIds(stale, wikiOwner, 'wiki');
}

// Full reconciliation: sync every page file, then drop pg wiki chunks whose
// trajectory_id matches no file (handles page deletion/rename).
export async function reindexWiki(
  wikiOwner: string,
  deps: Pick<WikiIngestDeps, 'backend' | 'store' | 'embedder'>
): Promise<{ pages: number; dropped: number }> {
  const { backend, store } = deps;
  store.init();
  const pages = store.listPages();
  for (const page of pages) await syncPageToIndex(page, wikiOwner, deps);

  const valid = new Set(pages.map((p) => `wiki:${p.slug}`));
  const orphanIds = (await backend.listWikiChunkIds(wikiOwner))
    .filter((c) => !c.trajectoryId || !valid.has(c.trajectoryId))
    .map((c) => c.id);
  const dropped = await backend.deleteChunksByIds(orphanIds, wikiOwner, 'wiki');
  return { pages: pages.length, dropped };
}
