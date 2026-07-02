import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, promptForMissing, configIsComplete } from '../config/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder } from '../ingest/embed.ts';
import { ingestFile } from '../ingest/pipeline.ts';

export async function backfillCommand(): Promise<void> {
  let config = loadConfig();
  if (!configIsComplete(config)) {
    console.log('First-time setup:');
    config = await promptForMissing(config);
    console.log('');
  }

  const backend = new PgVectorBackend(config.databaseUrl, config.embeddingDim);
  const local = new LocalStore();
  const embedder = new Embedder(config.openaiApiKey, config.embeddingModel);
  const deps = { backend, local, embedder, config };

  try {
    console.log('Initializing pgvector schema...');
    await backend.initialize();

    console.log(`Scanning ${config.watchPath}...`);
    const files = findJsonl(config.watchPath);
    console.log(`Found ${files.length} session file(s).\n`);

    let totals = { embedded: 0, skipped: 0, trajectories: 0 };
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      process.stdout.write(`  [${i + 1}/${files.length}] ${f.split('/').pop()} ... `);
      try {
        const r = await ingestFile(f, deps);
        totals.embedded += r.embedded;
        totals.skipped += r.skipped;
        totals.trajectories += r.trajectories;
        console.log(`embedded ${r.embedded}, skipped ${r.skipped}`);
      } catch (err) {
        console.log(`error: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log('');
    console.log(
      `Done. Embedded ${totals.embedded} new chunks from ${totals.trajectories} trajectories (${totals.skipped} already indexed).`
    );
  } finally {
    await backend.close();
    local.close();
  }
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
