import { loadConfig, configIsComplete, DEFAULT_OWNER } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore, type UnmetDemandRow } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { OpenAIDreamLLM, type DreamLLM } from '../dream/llm.ts';
import { OpenAIWikiLLM, type WikiIngestLLM } from '../wiki/llm.ts';
import { synthesizeDreams, type SynthesizeDeps } from '../dream/synthesize.ts';
import { ingestWiki, type WikiBackend } from '../wiki/ingest.ts';
import { lintWiki } from '../wiki/lint.ts';
import { WikiStore } from '../wiki/store.ts';
import { acquireSynthesisLock, type Lock } from './synthesisLock.ts';
import type { EngramConfig } from '../types/index.ts';

const OVERLAP_MS = 24 * 60 * 60 * 1000;

// Demand-report window (matches LocalStore.unmetDemand/demandSummary defaults)
// and the per-night cap on demand-targeted dream compilation. Both live here,
// once: the nightly run reads at most this many distinct sessions of unmet raw
// coverage and compiles them before the wiki phase. Small so a backlog of
// never-dreamed sessions drains over several nights rather than one giant run.
const DEMAND_DAYS = 30;
const MAX_TARGETED_SESSIONS = 5;

function log(phase: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), phase, ...data }));
}

// The heavy, real collaborators the run drives. Bundled behind one factory seam
// (SynthesisRunDeps.collaborators) so tests can swap the whole set — DB backend,
// embedder, and the two LLMs — for fakes without an OpenAI key or a live pg.
export interface SynthesisCollaborators {
  backend: SynthesizeDeps['backend'] &
    WikiBackend &
    Pick<PgVectorBackend, 'initialize' | 'close' | 'existingChunkIds' | 'pendingWikiUnits'>;
  embedder: Embedder;
  dreamLLM: DreamLLM;
  wikiLLM: WikiIngestLLM;
  wikiStore: WikiStore;
}

// Injectable seams (all optional; real defaults below). Same dependency-injection
// philosophy as buildUiFetch(UiDeps): the command is a thin wire-up so route/flow
// tests exercise the orchestration — phase lines, demand targeting, ordering —
// without touching the network, a live database, or a paid LLM.
export interface SynthesisRunDeps {
  config?: EngramConfig;
  local?: LocalStore;
  acquireLock?: () => Lock | null;
  collaborators?: (config: EngramConfig) => Promise<SynthesisCollaborators>;
  synthesize?: typeof synthesizeDreams;
  ingest?: typeof ingestWiki;
  lint?: typeof lintWiki;
  log?: (phase: string, data: Record<string, unknown>) => void;
}

async function defaultCollaborators(config: EngramConfig): Promise<SynthesisCollaborators> {
  const backend = PgVectorBackend.fromConfig(config);
  await backend.initialize();
  return {
    backend,
    embedder: new Embedder(buildProvider(config), backend),
    dreamLLM: new OpenAIDreamLLM(config.openaiApiKey, config.dreamModel),
    wikiLLM: new OpenAIWikiLLM(config.openaiApiKey, config.wikiModel),
    wikiStore: new WikiStore(config.wikiDir),
  };
}

// From the grouped unmet-demand report, pick the distinct raw sessions to
// re-dream this night: rows whose best hit is tier='raw' AND carries a
// top_session_id (uncompiled material exists), de-duplicated in most-demanded
// order, capped. The tier filter matters: weak synth-tier hits point at
// already-dreamed sessions — free fingerprint skips, but they'd burn the
// nightly cap and starve genuinely uncompiled sessions. Pure and exported so
// the targeting rule is unit-testable in isolation.
export function selectTargetedSessions(unmet: UnmetDemandRow[], cap = MAX_TARGETED_SESSIONS): string[] {
  const seen = new Set<string>();
  for (const row of unmet) {
    if (seen.size >= cap) break;
    const id = row.topSessionId;
    if (row.topTier === 'raw' && id && !seen.has(id)) seen.add(id);
  }
  return [...seen];
}

// Hidden headless command: dream synthesis → demand-targeted compilation → wiki
// ingest, end to end. Launchd nightly agent + watcher hook target. Fully
// non-interactive, one JSON line/phase.
export async function synthesisRunCommand(deps: SynthesisRunDeps = {}): Promise<void> {
  const lg = deps.log ?? log;
  const config = deps.config ?? loadConfig();
  if (!configIsComplete(config) || !config.openaiApiKey) {
    lg('error', { message: 'not configured or missing OPENAI_API_KEY' });
    process.exit(1);
  }

  const acquireLock = deps.acquireLock ?? acquireSynthesisLock;
  const lock = acquireLock();
  if (!lock) {
    lg('skipped', { reason: 'locked' });
    return;
  }

  const owner = DEFAULT_OWNER;
  const ownsLocal = !deps.local;
  const local = deps.local ?? new LocalStore();
  const lastRun = local.getStat('last_synthesis_at');
  const since = lastRun ? new Date(new Date(lastRun).getTime() - OVERLAP_MS) : undefined;

  const synthesize = deps.synthesize ?? synthesizeDreams;
  const ingest = deps.ingest ?? ingestWiki;
  const lint = deps.lint ?? lintWiki;
  const buildCollaborators = deps.collaborators ?? defaultCollaborators;

  let collab: SynthesisCollaborators | undefined;
  try {
    collab = await buildCollaborators(config);
    const { backend, embedder, dreamLLM, wikiLLM, wikiStore } = collab;

    const dream = await synthesize(
      { sourceOwner: owner, dreamOwner: owner, since, limit: 1000, dryRun: false },
      { backend, embedder, llm: dreamLLM, config }
    );
    lg('dream', { synthesized: dream.synthesized, dreamChunks: dream.dreamChunks, skipped: dream.skipped, failed: dream.failed });

    // Demand-targeted compilation, BEFORE the wiki phase so this same run's wiki
    // ingest picks up the freshly-created dream units. Sessions with real raw
    // coverage that queries never found compiled (top_session_id present) get a
    // scoped re-dream; fingerprints make an already-compiled session a free skip,
    // so a second night over the same demand no-ops.
    const summary = local.demandSummary(DEMAND_DAYS);
    const targeted = selectTargetedSessions(local.unmetDemand(DEMAND_DAYS), config.synthesis.targetedSessionsPerNight);
    let targetedSynthesized = 0;
    let targetedDreamChunks = 0;
    for (const sessionId of targeted) {
      const t = await synthesize(
        { sourceOwner: owner, dreamOwner: owner, sessionId, limit: 1000, dryRun: false },
        { backend, embedder, llm: dreamLLM, config }
      );
      targetedSynthesized += t.synthesized;
      targetedDreamChunks += t.dreamChunks;
    }
    const demandLine = {
      days: summary.days,
      total: summary.total,
      searches: summary.searches,
      asks: summary.asks,
      unmet: summary.unmet,
      unmetQueries: summary.unmetQueries,
      targetedSessions: targeted.length,
      targetedSynthesized,
      targetedDreamChunks,
    };
    lg('demand', demandLine);
    // Trend snapshot: never let a snapshot write affect the run.
    try {
      local.addSnapshot('demand', demandLine);
    } catch {
      /* best effort */
    }

    const wiki = await ingest(
      { sourceOwner: owner, wikiOwner: owner, limit: 1000, dryRun: false },
      { backend, store: wikiStore, embedder, llm: wikiLLM, config }
    );
    lg('wiki', {
      unitsCompiled: wiki.unitsCompiled,
      pagesCreated: wiki.pagesCreated,
      pagesUpdated: wiki.pagesUpdated,
      pagesSkippedGuard: wiki.pagesSkippedGuard,
      pagesRetried: wiki.pagesRetried,
      pagesAddendum: wiki.pagesAddendum,
      failed: wiki.failed,
    });

    // Lint the freshly-compiled wiki: one health line. A lint failure is
    // informational, never fatal — it must not fail the nightly run.
    try {
      const findings = await lint(wikiStore, {
        checkProvenance: (ids) => backend.existingChunkIds(ids, 'dream'),
        pendingUnits: () => backend.pendingWikiUnits(owner),
      });
      const warns = findings.filter((f) => f.severity === 'warn').length;
      const rules: Record<string, number> = {};
      for (const f of findings) rules[f.rule] = (rules[f.rule] ?? 0) + 1;
      const lintLine = { warns, infos: findings.length - warns, rules };
      lg('lint', lintLine);
      // Trend snapshot: never let a snapshot write affect the run.
      try {
        local.addSnapshot('lint', lintLine);
      } catch {
        /* best effort */
      }
    } catch (err) {
      lg('lint', { error: err instanceof Error ? err.message : String(err) });
    }

    // Stamp only after all phases complete (overlap is free — fingerprints skip).
    const now = new Date().toISOString();
    local.setStat('last_synthesis_at', now);
    local.setStat('last_wiki_ingest_at', now);
    lg('done', {});
  } catch (err) {
    lg('error', { message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    lock.release();
    if (ownsLocal) local.close();
    if (collab) await collab.backend.close();
  }
}
