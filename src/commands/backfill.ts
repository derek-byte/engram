import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, promptForMissing, configIsComplete, DEFAULT_OWNER } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { collectArtifacts } from '../ingest/artifacts.ts';
import { ingestFile, type PipelineDeps } from '../ingest/pipeline.ts';
import { CHUNKER_VERSION } from '../types/index.ts';
import type { MaintenanceStore } from '../storage/backend.ts';

// The ingest deps plus the reindex sweep. PgVectorBackend and the test
// FakeBackend both satisfy the backend intersection.
export interface BackfillDeps extends PipelineDeps {
  backend: PipelineDeps['backend'] & Pick<MaintenanceStore, 'deleteChunksByStaleVersion'>;
}

export interface BackfillSummary {
  files: number;
  sessions: number;
  trajectories: number;
  embedded: number;
  skipped: number;
  cacheHits: number;
  cacheMisses: number;
  errors: number;
  // Stale-chunker rows deleted by the reindex sweep (0 when not reindexing or
  // when the sweep was withheld because a file errored).
  swept: number;
}

// The backfill/reindex core, extracted from the CLI shell so tests can drive it
// with FakeBackend + tempStore. Reindex order is deliberate for crash-safety:
//   1. clear ingest bookkeeping (cursors + seen hashes) — re-chunk everything;
//   2. re-ingest every session (transient duplicates are tolerable: upsert is
//      id-idempotent and re-embeds hit the embedding cache);
//   3. ONLY after a pass with zero per-file errors, sweep the owner's raw-tier
//      chunks whose chunker_version differs from the current one (loss is NOT
//      tolerable, so the sweep never runs on a partial pass).
// A crash mid-run is resumable: re-running repeats 1–2 (converging on the same
// content-derived ids) and the sweep happens on the first fully clean pass.
export async function runBackfillIngest(
  files: string[],
  deps: BackfillDeps,
  opts: { reindex?: boolean; log?: (line: string) => void } = {}
): Promise<BackfillSummary> {
  const log = opts.log ?? (() => {});
  const owner = deps.owner ?? DEFAULT_OWNER;

  if (opts.reindex) {
    deps.local.clearIngestState();
    log(`Reindex: cleared ingest bookkeeping; re-chunking every session (chunker ${CHUNKER_VERSION}).`);
  }

  const summary: BackfillSummary = {
    files: files.length,
    sessions: 0,
    trajectories: 0,
    embedded: 0,
    skipped: 0,
    cacheHits: 0,
    cacheMisses: 0,
    errors: 0,
    swept: 0,
  };

  const sessions = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    try {
      const r = await ingestFile(f, deps);
      if (r.sessionId) sessions.add(r.sessionId);
      summary.embedded += r.embedded;
      summary.skipped += r.skipped;
      summary.trajectories += r.trajectories;
      summary.cacheHits += r.cacheHits;
      summary.cacheMisses += r.cacheMisses;
      log(`  [${i + 1}/${files.length}] ${f.split('/').pop()} ... embedded ${r.embedded}, skipped ${r.skipped}`);
    } catch (err) {
      summary.errors++;
      log(`  [${i + 1}/${files.length}] ${f.split('/').pop()} ... error: ${err instanceof Error ? err.message : err}`);
    }
  }
  summary.sessions = sessions.size;

  if (opts.reindex) {
    if (summary.errors === 0) {
      summary.swept = await deps.backend.deleteChunksByStaleVersion(owner, 'raw', CHUNKER_VERSION);
    } else {
      log(`Reindex: ${summary.errors} file(s) errored — sweep withheld; re-run to converge.`);
    }
  }

  return summary;
}

export async function backfillCommand(opts: { artifacts?: boolean; reindex?: boolean } = {}): Promise<void> {
  let config = loadConfig();
  if (!configIsComplete(config)) {
    console.log('First-time setup:');
    config = await promptForMissing(config);
    console.log('');
  }

  const backend = PgVectorBackend.fromConfig(config);
  const local = new LocalStore();
  const embedder = new Embedder(buildProvider(config), backend);
  const deps: BackfillDeps = { backend, local, embedder, config };

  try {
    console.log('Initializing pgvector schema...');
    await backend.initialize();

    if (opts.artifacts) {
      await backfillArtifacts(backend);
      return;
    }

    console.log(`Scanning ${config.watchPath}...`);
    const files = findJsonl(config.watchPath);
    console.log(`Found ${files.length} session file(s).\n`);

    const s = await runBackfillIngest(files, deps, { reindex: opts.reindex, log: (line) => console.log(line) });

    console.log('');
    console.log(
      `Done. ${s.sessions} sessions, embedded ${s.embedded} new chunks from ${s.trajectories} trajectories (${s.skipped} already indexed).`
    );
    console.log(`Embedding cache: ${s.cacheHits} hits, ${s.cacheMisses} misses.`);
    if (opts.reindex) {
      console.log(
        s.errors === 0
          ? `Reindex sweep: ${s.swept} stale chunker-version chunk(s) removed.`
          : `Reindex sweep withheld (${s.errors} file error(s)); stale chunks kept — re-run \`engram backfill --reindex\`.`
      );
    }
  } finally {
    await backend.close();
    local.close();
  }
}

// Re-derive artifacts for chunks already ingested and write them into
// chunks.artifacts. A plain re-ingest can't do this: upsert is ON CONFLICT DO
// NOTHING and the pipeline's hasSeen() skips existing chunk hashes, so both
// silently no-op. This sweep reads raw_events payloads (source 'claude-code',
// each payload is the full Trajectory incl. toolCalls) and UPDATEs only the
// artifacts column of the raw-tier chunks — embeddings/content are untouched.
// Note: payload tool outputs are already truncated (2000 chars) by the chunker,
// so a URL beyond that cut-off won't be seen here. Acceptable for a backfill.
async function backfillArtifacts(backend: PgVectorBackend): Promise<void> {
  console.log('Backfilling artifacts from raw_events...');
  const trajectories = await backend.rawTrajectoriesForArtifacts('claude-code');

  let withArtifacts = 0;
  let chunksUpdated = 0;
  for (const t of trajectories) {
    const artifacts = collectArtifacts(t.payload.toolCalls ?? []);
    if (artifacts.length === 0) continue;
    withArtifacts++;
    chunksUpdated += await backend.setChunkArtifacts(t.trajectoryId, artifacts);
  }

  console.log(
    `Done. Scanned ${trajectories.length} trajectories, ${withArtifacts} with artifacts, ${chunksUpdated} chunks updated.`
  );
}

// Exported so the chunker A/B benchmark discovers sessions exactly like backfill.
export function findJsonl(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...findJsonl(full));
    } else if (name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}
