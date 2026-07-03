import { existsSync, statSync } from 'node:fs';
import { loadConfig, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { OpenAIWikiLLM } from '../wiki/llm.ts';
import { WikiStore } from '../wiki/store.ts';
import { ingestWiki, reindexWiki, type WikiIngestResult, type WikiUnitPlan } from '../wiki/ingest.ts';
import { splitPage } from '../wiki/split.ts';
import { lintWiki, type Finding } from '../wiki/lint.ts';
import { acquireSynthesisLock } from './synthesisLock.ts';

export interface WikiOptions {
  repo?: string;
  since?: string;
  limit?: string;
  owner?: string;
  wikiOwner?: string;
  dryRun?: boolean;
  json?: boolean;
  llm?: boolean;
}

function makeBackend(config: ReturnType<typeof loadConfig>): PgVectorBackend {
  return new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION, {
    vectorWeight: config.vectorWeight,
    keywordWeight: config.keywordWeight,
    timeDecayHalfLifeDays: config.timeDecayHalfLifeDays,
  });
}

function requireConfigured(config: ReturnType<typeof loadConfig>): void {
  if (!configIsComplete(config)) {
    console.error("engram isn't configured yet. Run 'engram backfill' first.");
    process.exit(1);
  }
}

export async function wikiCommand(action: string, slug: string | undefined, opts: WikiOptions): Promise<void> {
  switch (action) {
    case 'ingest':
      return wikiIngest(opts);
    case 'lint':
      return wikiLint(opts);
    case 'status':
      return wikiStatus(opts);
    case 'reindex':
      return wikiReindex(opts);
    case 'split':
      return wikiSplit(slug, opts);
    default:
      console.error(`Unknown action '${action}'. Use: ingest | lint | status | reindex | split`);
      process.exit(1);
  }
}

async function wikiIngest(opts: WikiOptions): Promise<void> {
  const config = loadConfig();
  requireConfigured(config);

  if (!opts.dryRun && !config.openaiApiKey) {
    console.error('engram wiki ingest needs an OpenAI API key (set OPENAI_API_KEY) to compile pages.');
    process.exit(1);
  }

  const since = opts.since ? new Date(opts.since) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    console.error(`invalid '--since' date: ${opts.since} (use ISO format, e.g. 2026-01-15)`);
    process.exit(1);
  }
  const parsedLimit = opts.limit ? Number(opts.limit) : 20;
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.floor(parsedLimit)) : 20;
  const sourceOwner = opts.owner ?? 'derek';
  const wikiOwner = opts.wikiOwner ?? sourceOwner;

  // Lock only for a real run — a dry-run neither calls the LLM nor writes.
  const lock = opts.dryRun ? { release() {} } : acquireSynthesisLock();
  if (!lock) {
    const msg = { skipped: 'locked' as const };
    if (opts.json) console.log(JSON.stringify(msg, null, 2));
    else console.log('another synthesis run is active; skipping.');
    return;
  }

  const backend = makeBackend(config);
  await backend.initialize();
  const embedder = new Embedder(buildProvider(config), backend);
  const store = new WikiStore(config.wikiDir);
  const llm = new OpenAIWikiLLM(config.openaiApiKey, config.wikiModel);

  try {
    const result = await ingestWiki(
      { sourceOwner, wikiOwner, repo: opts.repo, since, limit, dryRun: Boolean(opts.dryRun) },
      { backend, store, embedder, llm, config }
    );
    if (!opts.dryRun) new LocalStore().setStat('last_wiki_ingest_at', new Date().toISOString());
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.dryRun) {
      printPlan(result, config.wikiModel);
    } else {
      console.log(
        `compiled ${result.unitsCompiled} unit(s): ${result.pagesCreated} created, ${result.pagesUpdated} updated, ` +
          `${result.pagesSkippedGuard} guarded, skipped ${result.unitsSkipped} unchanged, deferred ${result.deferred}, failed ${result.failed}`
      );
      console.log(`tokens: ${result.promptTokens} prompt, ${result.completionTokens} completion`);
      console.log(`wiki: ${store.dir}`);
    }
  } finally {
    lock.release();
    await backend.close();
  }
}

function printPlan(result: WikiIngestResult, model: string): void {
  const plan: WikiUnitPlan[] = result.plan ?? [];
  if (plan.length === 0) {
    console.log(`Nothing to compile (${result.unitsSkipped} unchanged, ${result.deferred} deferred).`);
    return;
  }
  console.log(`Would compile ${plan.length} unit(s) with ${model} (${result.unitsSkipped} unchanged, ${result.deferred} deferred):\n`);
  for (const p of plan) {
    console.log(`  [${p.status}] ${p.sessionId.slice(0, 12)} · ${p.repo || '(no repo)'} · ${p.items} items · ~${p.estTokens} tokens`);
  }
  console.log(`\nEstimated total input: ~${result.estTotalTokens ?? 0} tokens.`);
}

async function wikiReindex(opts: WikiOptions): Promise<void> {
  const config = loadConfig();
  requireConfigured(config);
  const wikiOwner = opts.wikiOwner ?? opts.owner ?? 'derek';
  const backend = makeBackend(config);
  await backend.initialize();
  const embedder = new Embedder(buildProvider(config), backend);
  const store = new WikiStore(config.wikiDir);
  try {
    const res = await reindexWiki(wikiOwner, { backend, store, embedder });
    if (opts.json) console.log(JSON.stringify(res, null, 2));
    else console.log(`reindexed ${res.pages} page(s), dropped ${res.dropped} stale pg chunk(s).`);
  } finally {
    await backend.close();
  }
}

async function wikiSplit(slug: string | undefined, opts: WikiOptions): Promise<void> {
  if (!slug) {
    console.error('engram wiki split needs a page slug: engram wiki split <slug>');
    process.exit(1);
  }
  const config = loadConfig();
  requireConfigured(config);

  if (!opts.dryRun && !config.openaiApiKey) {
    console.error('engram wiki split needs an OpenAI API key (set OPENAI_API_KEY) to rewrite the hub.');
    process.exit(1);
  }

  const wikiOwner = opts.wikiOwner ?? opts.owner ?? 'derek';

  // Writes pages + pg like ingest → share the synthesis lock (dry-run neither
  // calls the LLM nor writes).
  const lock = opts.dryRun ? { release() {} } : acquireSynthesisLock();
  if (!lock) {
    const msg = { skipped: 'locked' as const };
    if (opts.json) console.log(JSON.stringify(msg, null, 2));
    else console.log('another synthesis run is active; skipping.');
    return;
  }

  const backend = makeBackend(config);
  await backend.initialize();
  const embedder = new Embedder(buildProvider(config), backend);
  const store = new WikiStore(config.wikiDir);
  const llm = new OpenAIWikiLLM(config.openaiApiKey, config.wikiModel);

  try {
    const result = await splitPage(
      { wikiOwner, slug, dryRun: Boolean(opts.dryRun) },
      { backend, store, embedder, llm, config }
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.dryRun) {
      console.log(`Would split [[${result.slug}]] (${result.hubChars.before} chars, ~${result.estTokens} tokens) with ${config.wikiModel}.`);
    } else {
      console.log(
        `split [[${result.slug}]]: ${result.children.length} child page(s) — hub ${result.hubChars.before} → ${result.hubChars.after} chars ` +
          `(shrink guard bypassed), sources inherited ${result.sourcesInherited.subset} subset / ${result.sourcesInherited.full} full`
      );
      console.log(`children: ${result.children.map((c) => `[[${c}]]`).join(', ')}`);
      console.log(`tokens: ${result.promptTokens} prompt, ${result.completionTokens} completion`);
      console.log(`wiki: ${store.dir}`);
    }
  } catch (err) {
    console.error(`wiki split failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    lock.release();
    await backend.close();
  }
}

async function wikiLint(opts: WikiOptions): Promise<void> {
  const config = loadConfig();
  const store = new WikiStore(config.wikiDir);
  const wikiOwner = opts.wikiOwner ?? opts.owner ?? 'derek';

  let backend: PgVectorBackend | undefined;
  let checkProvenance: ((ids: string[]) => Promise<Set<string>>) | undefined;
  if (configIsComplete(config)) {
    backend = makeBackend(config);
    await backend.initialize();
    const b = backend;
    checkProvenance = (ids: string[]) => b.existingChunkIds(ids, 'dream');
  }
  void wikiOwner;

  try {
    const findings = await lintWiki(store, { checkProvenance });
    if (opts.json) {
      console.log(JSON.stringify(findings, null, 2));
    } else {
      printFindings(findings);
    }
  } finally {
    if (backend) await backend.close();
  }
}

function printFindings(findings: Finding[]): void {
  if (findings.length === 0) {
    console.log('No findings — the wiki is clean.');
    return;
  }
  const warn = findings.filter((f) => f.severity === 'warn').length;
  const info = findings.length - warn;
  console.log(`${findings.length} finding(s): ${warn} warn, ${info} info\n`);
  for (const f of findings) {
    const where = f.page ? ` [[${f.page}]]` : '';
    console.log(`  ${f.severity === 'warn' ? '⚠' : 'ℹ'} ${f.rule}${where}: ${f.detail}`);
  }
}

async function wikiStatus(opts: WikiOptions): Promise<void> {
  const config = loadConfig();
  const store = new WikiStore(config.wikiDir);
  const wikiOwner = opts.wikiOwner ?? opts.owner ?? 'derek';
  const sourceOwner = opts.owner ?? 'derek';

  const pages = store.listPages();
  const graph = store.linkGraph(pages);
  const byKind: Record<string, number> = {};
  let orphans = 0;
  let linkCount = 0;
  for (const p of pages) {
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    if ((graph.inbound.get(p.slug)?.length ?? 0) === 0) orphans++;
    linkCount += graph.outbound.get(p.slug)?.length ?? 0;
  }

  const local = new LocalStore();
  const lastIngest = local.getStat('last_wiki_ingest_at');
  local.close();
  const indexFresh = indexIsFresh(store);
  const head = store.head();

  let pendingUnits: number | null = null;
  if (configIsComplete(config)) {
    const backend = makeBackend(config);
    try {
      await backend.initialize();
      const dreamUnits = await backend.listDreamUnitsAsUnits(sourceOwner, {});
      const ledger = new Set((await backend.getWikiUnits(wikiOwner)).map((u) => `${u.sessionId}\n${u.repo}`));
      pendingUnits = dreamUnits.filter((u) => !ledger.has(`${u.sessionId}\n${u.repo}`)).length;
    } catch {
      pendingUnits = null;
    } finally {
      await backend.close();
    }
  }

  const out = {
    wikiDir: store.dir,
    pages: pages.length,
    byKind,
    links: linkCount,
    orphans,
    lastIngest,
    indexFresh,
    pendingUnits,
    gitHead: head,
  };
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log('engram wiki status');
  console.log('──────────────────');
  console.log(`wiki dir:      ${out.wikiDir}`);
  console.log(`pages:         ${out.pages} (${Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join(', ') || 'none'})`);
  console.log(`links:         ${out.links} (${out.orphans} orphan${out.orphans === 1 ? '' : 's'})`);
  console.log(`last ingest:   ${out.lastIngest ?? 'never'}`);
  console.log(`index fresh:   ${out.indexFresh}`);
  console.log(`pending units: ${out.pendingUnits ?? 'unknown'}`);
  console.log(`git head:      ${out.gitHead ?? 'none'}`);
}

function indexIsFresh(store: WikiStore): boolean {
  if (!existsSync(store.indexPath)) return false;
  try {
    const indexMtime = statSync(store.indexPath).mtimeMs;
    let maxPage = 0;
    for (const slug of store.listSlugs()) {
      const m = statSync(store.pagePath(slug)).mtimeMs;
      if (m > maxPage) maxPage = m;
    }
    return indexMtime >= maxPage;
  } catch {
    return false;
  }
}
