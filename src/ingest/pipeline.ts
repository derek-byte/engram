import { statSync } from 'node:fs';
import type { Chunk, EngramConfig } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder, MAX_CHARS_PER_INPUT } from './embed.ts';
import { trajectoryHash } from './hash.ts';
import { chunkMessages, trajectoryToText } from './chunker.ts';
import { parseJsonl } from './parser.ts';

export interface PipelineDeps {
  backend: VectorBackend;
  embedder: Embedder;
  local: LocalStore;
  config: EngramConfig;
}

export interface IngestResult {
  trajectories: number;
  embedded: number;
  skipped: number;
}

export async function ingestFile(path: string, deps: PipelineDeps): Promise<IngestResult> {
  const messages = parseJsonl(path);
  const trajectories = chunkMessages(messages);
  if (trajectories.length === 0) {
    return { trajectories: 0, embedded: 0, skipped: 0 };
  }

  const sessionId = trajectories[0]!.sessionId;
  const cursor = deps.local.getCursor(sessionId);
  const fresh = trajectories.slice(cursor);

  const toEmbed: Array<{ text: string; hash: string; trajectory: (typeof trajectories)[number] }> = [];
  let skipped = 0;

  for (const t of fresh) {
    const text = trajectoryToText(t);
    const hash = trajectoryHash(t);
    if (deps.local.hasSeen(hash)) {
      skipped++;
      continue;
    }
    if (text.length > MAX_CHARS_PER_INPUT) {
      console.error(
        `[ingest] skipping oversized trajectory ${t.sessionId} (${hash}): ${text.length} chars (limit ${MAX_CHARS_PER_INPUT})`
      );
      skipped++;
      continue;
    }
    toEmbed.push({ text, hash, trajectory: t });
  }

  let embedded = 0;
  for (let i = 0; i < toEmbed.length; i += deps.config.chunkBatchSize) {
    const batch = toEmbed.slice(i, i + deps.config.chunkBatchSize);
    const vectors = await deps.embedder.embed(
      batch.map((b) => b.text),
      batch.map((b) => `${b.trajectory.sessionId} (${b.hash})`)
    );

    const chunks: Chunk[] = batch.map((b, idx) => ({
      id: b.hash,
      embedding: vectors[idx]!,
      content: b.text,
      metadata: {
        repo: b.trajectory.repo,
        branch: b.trajectory.branch,
        timestamp: b.trajectory.timestamp,
        filePaths: b.trajectory.filePaths,
        exitCode: b.trajectory.exitCode,
        sessionId: b.trajectory.sessionId,
        cwd: b.trajectory.cwd,
        tier: 'raw',
      },
    }));

    await deps.backend.upsert(chunks);
    for (const b of batch) deps.local.markSeen(b.hash);
    embedded += chunks.length;
  }

  deps.local.setCursor(sessionId, trajectories.length);
  deps.local.setStat('last_ingest_at', new Date().toISOString());

  return { trajectories: trajectories.length, embedded, skipped };
}

export function fileIsStable(path: string, minIdleMs: number): boolean {
  try {
    const stat = statSync(path);
    return Date.now() - stat.mtimeMs >= minIdleMs;
  } catch {
    return false;
  }
}
