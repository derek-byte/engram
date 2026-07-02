import { statSync } from 'node:fs';
import type { Chunk, EngramConfig, RawEvent } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
import { LocalStore } from '../storage/local.ts';
import { Embedder } from './embed.ts';
import { contentSha256, trajectoryHash } from './hash.ts';
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
  cacheHits: number;
  cacheMisses: number;
}

export async function ingestFile(path: string, deps: PipelineDeps): Promise<IngestResult> {
  const messages = parseJsonl(path);
  const trajectories = chunkMessages(messages);
  if (trajectories.length === 0) {
    return { trajectories: 0, embedded: 0, skipped: 0, cacheHits: 0, cacheMisses: 0 };
  }

  const sessionId = trajectories[0]!.sessionId;
  const cursor = deps.local.getCursor(sessionId);
  const fresh = trajectories.slice(cursor);

  const toEmbed: Array<{ text: string; hash: string; trajectory: (typeof trajectories)[number] }> = [];
  const rawEvents: RawEvent[] = [];
  let skipped = 0;

  for (const t of fresh) {
    const text = trajectoryToText(t);
    const hash = trajectoryHash(t);
    rawEvents.push({
      source: 'claude-code',
      sessionId: t.sessionId,
      contentSha256: contentSha256(text),
      occurredAt: t.timestamp,
      payload: t,
    });
    if (deps.local.hasSeen(hash)) {
      skipped++;
      continue;
    }
    toEmbed.push({ text, hash, trajectory: t });
  }

  await deps.backend.insertRawEvents(rawEvents);

  const cacheHits0 = deps.embedder.cacheHits;
  const cacheMisses0 = deps.embedder.cacheMisses;

  let embedded = 0;
  for (let i = 0; i < toEmbed.length; i += deps.config.chunkBatchSize) {
    const batch = toEmbed.slice(i, i + deps.config.chunkBatchSize);
    const vectors = await deps.embedder.embed(batch.map((b) => b.text));

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

  return {
    trajectories: trajectories.length,
    embedded,
    skipped,
    cacheHits: deps.embedder.cacheHits - cacheHits0,
    cacheMisses: deps.embedder.cacheMisses - cacheMisses0,
  };
}

export function fileIsStable(path: string, minIdleMs: number): boolean {
  try {
    const stat = statSync(path);
    return Date.now() - stat.mtimeMs >= minIdleMs;
  } catch {
    return false;
  }
}
