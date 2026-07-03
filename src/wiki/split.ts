import type { EngramConfig } from '../types/index.ts';
import type { Embedder } from '../ingest/embed.ts';
import { CHARS_PER_TOKEN } from '../ingest/chunker.ts';
import type { WikiSplitLLM, WikiPageOp } from './llm.ts';
import { WikiStore, pageFingerprint, type WikiPage } from './store.ts';
import { autolinkBody } from './links.ts';
import { syncPageToIndex, buildLinkTargets, type WikiBackend } from './ingest.ts';

export interface WikiSplitParams {
  wikiOwner: string; // owner the wiki pg chunks are written under
  slug: string; // the oversized hub page to split
  dryRun: boolean;
}

export interface WikiSplitDeps {
  backend: WikiBackend;
  store: WikiStore;
  embedder: Embedder;
  llm: WikiSplitLLM;
  config: EngramConfig;
}

export interface WikiSplitResult {
  slug: string;
  children: string[];
  hubChars: { before: number; after: number };
  shrinkGuardBypassed: boolean;
  sourcesInherited: { subset: number; full: number };
  promptTokens: number;
  completionTokens: number;
  dryRun: boolean;
  estTokens?: number;
}

// Split one oversized hub page into a short link-index hub + focused child pages
// via a single LLM call. The hub rewrite legitimately shrinks, so this path
// deliberately does NOT invoke the shrink guard for the hub op (recorded as
// shrinkGuardBypassed). Reuses the exact ingest write path (writePage →
// syncPageToIndex → renderIndex → commit) so a split is one git revert away.
export async function splitPage(params: WikiSplitParams, deps: WikiSplitDeps): Promise<WikiSplitResult> {
  const { store, llm } = deps;
  if (!params.dryRun) store.init();

  const hub = store.readPage(params.slug);
  if (!hub) throw new Error(`wiki split: page '${params.slug}' not found`);

  const beforeChars = hub.body.length;

  if (params.dryRun) {
    return {
      slug: hub.slug,
      children: [],
      hubChars: { before: beforeChars, after: beforeChars },
      shrinkGuardBypassed: true,
      sourcesInherited: { subset: 0, full: 0 },
      promptTokens: 0,
      completionTokens: 0,
      dryRun: true,
      estTokens: Math.ceil(beforeChars / CHARS_PER_TOKEN),
    };
  }

  const { pages: ops, usage } = await llm.split(hub, store.inventory());
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;

  // Validate: exactly one update op for the hub slug (else fail, nothing written).
  const hubMatches = ops.filter((o) => o.slug === hub.slug);
  const hubOp = hubMatches[0];
  if (hubMatches.length !== 1 || !hubOp || hubOp.action !== 'update') {
    throw new Error(
      `wiki split: expected exactly one 'update' op for hub slug '${hub.slug}', got ${hubMatches.length} (nothing written)`
    );
  }

  // Children: creates whose slugs don't already exist as another page on disk.
  // Drop violators with a warning — a split must never silently rewrite an
  // unrelated existing page.
  const existingSlugs = new Set(store.listSlugs());
  const childOps: WikiPageOp[] = [];
  const childSlugs = new Set<string>();
  for (const op of ops) {
    if (op.slug === hub.slug) continue;
    if (op.action !== 'create') {
      console.warn(`[wiki] split: dropping child op ${op.slug} — action '${op.action}' is not 'create'`);
      continue;
    }
    if (existingSlugs.has(op.slug)) {
      console.warn(`[wiki] split: dropping child op ${op.slug} — slug already exists (would overwrite an unrelated page)`);
      continue;
    }
    if (childSlugs.has(op.slug)) {
      console.warn(`[wiki] split: dropping duplicate child op ${op.slug} — same slug emitted twice in one response`);
      continue;
    }
    childSlugs.add(op.slug);
    childOps.push(op);
  }
  if (childOps.length === 0) {
    throw new Error(`wiki split: no valid child pages in the response for '${hub.slug}' (nothing written)`);
  }

  const now = new Date().toISOString();
  const hubSourceSet = new Set(hub.sources);

  // Auto-link every body against inventory ∪ new children ∪ hub, so the hub index
  // and children get guaranteed edges and interlink.
  const targets = buildLinkTargets(store.listPages(), [hubOp, ...childOps]);

  let subsetInherited = 0;
  let fullInherited = 0;
  const children: string[] = [];
  const toWrite: WikiPage[] = [];

  for (const op of childOps) {
    let childSources = op.sources.filter((s) => hubSourceSet.has(s));
    if (childSources.length === 0) {
      childSources = [...hub.sources]; // fallback: inherit the full hub set
      fullInherited++;
    } else {
      subsetInherited++;
    }
    const body = autolinkBody(op.body, targets, op.slug).body;
    toWrite.push({
      slug: op.slug,
      schema: hub.schema,
      title: op.title,
      kind: op.kind,
      summary: op.summary,
      aliases: op.aliases,
      sources: childSources,
      trajectories: [...hub.trajectories], // per-claim trajectory subsetting isn't determinable
      fingerprint: pageFingerprint(childSources),
      created: now,
      updated: now,
      body,
    });
    children.push(op.slug);
  }

  // The rewritten hub keeps its FULL source set (fingerprint semantics preserved).
  const hubBody = autolinkBody(hubOp.body, targets, hub.slug).body;
  toWrite.push({
    slug: hub.slug,
    schema: hub.schema,
    title: hubOp.title || hub.title,
    kind: hubOp.kind,
    summary: hubOp.summary || hub.summary,
    aliases: [...new Set([...hub.aliases, ...hubOp.aliases])],
    sources: hub.sources,
    trajectories: hub.trajectories,
    fingerprint: pageFingerprint(hub.sources),
    created: hub.created || now,
    updated: now,
    body: hubBody,
  });
  const afterChars = hubBody.length;

  // Same write path as ingest — no shrink guard for the hub op (deliberate bypass).
  for (const page of toWrite) {
    store.writePage(page);
    await syncPageToIndex(page, params.wikiOwner, deps);
  }
  store.renderIndex();
  store.commit(`wiki split ${hub.slug}: ${children.length} child page(s)`);

  return {
    slug: hub.slug,
    children,
    hubChars: { before: beforeChars, after: afterChars },
    shrinkGuardBypassed: true,
    sourcesInherited: { subset: subsetInherited, full: fullInherited },
    promptTokens,
    completionTokens,
    dryRun: false,
  };
}
