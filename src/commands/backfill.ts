import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, promptForMissing, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { collectArtifacts } from '../ingest/artifacts.ts';
import { ingestFile } from '../ingest/pipeline.ts';

export async function backfillCommand(opts: { artifacts?: boolean } = {}): Promise<void> {
  let config = loadConfig();
  if (!configIsComplete(config)) {
    console.log('First-time setup:');
    config = await promptForMissing(config);
    console.log('');
  }

  const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim, config.embeddingModel, CHUNKER_VERSION);
  const local = new LocalStore();
  const embedder = new Embedder(buildProvider(config), backend);
  const deps = { backend, local, embedder, config };

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

    let totals = { embedded: 0, skipped: 0, trajectories: 0, cacheHits: 0, cacheMisses: 0 };
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      process.stdout.write(`  [${i + 1}/${files.length}] ${f.split('/').pop()} ... `);
      try {
        const r = await ingestFile(f, deps);
        totals.embedded += r.embedded;
        totals.skipped += r.skipped;
        totals.trajectories += r.trajectories;
        totals.cacheHits += r.cacheHits;
        totals.cacheMisses += r.cacheMisses;
        console.log(`embedded ${r.embedded}, skipped ${r.skipped}`);
      } catch (err) {
        console.log(`error: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log('');
    console.log(
      `Done. Embedded ${totals.embedded} new chunks from ${totals.trajectories} trajectories (${totals.skipped} already indexed).`
    );
    console.log(`Embedding cache: ${totals.cacheHits} hits, ${totals.cacheMisses} misses.`);
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

function findJsonl(root: string): string[] {
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
