import type { Chunk, EngramConfig, RawEvent } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
import { Embedder } from './embed.ts';
import { chunkHash, contentSha256 } from './hash.ts';
import { chunkText } from './chunker.ts';

// Generic document to inject into the standard raw_events + chunks flow. This is
// the connector entry point: anything that can be reduced to (id, text, owner)
// — not just Claude Code trajectories — lands here.
export interface InjectDoc {
  id: string;
  content: string;
  occurredAt?: Date;
  source: string;
  owner: string;
}

export interface InjectDeps {
  backend: VectorBackend;
  embedder: Embedder;
  config: EngramConfig;
}

export interface InjectResult {
  documents: number;
  embedded: number;
  cacheHits: number;
  cacheMisses: number;
}

// Bulk direct-injection: chunk each document with the same token-aware packing
// as trajectories, embed through the cache, and upsert. Unlike the Claude Code
// pipeline this keeps no local cursor/seen-hash bookkeeping — each call is
// self-contained and idempotent via the DB's content_sha / chunk-id conflicts.
export async function injectDocuments(docs: InjectDoc[], deps: InjectDeps): Promise<InjectResult> {
  const toEmbed: Array<{
    text: string;
    hash: string;
    doc: InjectDoc;
    occurredAt: Date;
    trajectoryId: string;
    chunkIndex: number;
    chunkCount: number;
  }> = [];
  const rawEvents: RawEvent[] = [];

  for (const doc of docs) {
    // Namespaced by owner + doc id (like trajectoryHash includes sessionId) so
    // identical content injected as different docs or for different owners never
    // shares raw-event / chunk rows — otherwise one owner's retraction could
    // strand another's data.
    const trajectoryId = contentSha256(`${doc.owner}\n${doc.id}\n${doc.content}`);
    const texts = chunkText(doc.content);
    const occurredAt = doc.occurredAt ?? new Date();
    rawEvents.push({
      owner: doc.owner,
      source: doc.source,
      sessionId: doc.id,
      contentSha256: trajectoryId,
      occurredAt,
      payload: { id: doc.id, content: doc.content },
    });
    texts.forEach((text, chunkIndex) => {
      toEmbed.push({
        text,
        hash: chunkHash(trajectoryId, chunkIndex, text),
        doc,
        occurredAt,
        trajectoryId,
        chunkIndex,
        chunkCount: texts.length,
      });
    });
  }

  await deps.backend.insertRawEvents(rawEvents);

  let embedded = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  for (let i = 0; i < toEmbed.length; i += deps.config.chunkBatchSize) {
    const batch = toEmbed.slice(i, i + deps.config.chunkBatchSize);
    const { embeddings: vectors, ...stats } = await deps.embedder.embedWithStats(
      batch.map((b) => b.text),
      batch.map((b) => `${b.doc.id} (${b.hash})`)
    );
    cacheHits += stats.cacheHits;
    cacheMisses += stats.cacheMisses;

    const chunks: Chunk[] = batch.map((b, idx) => ({
      id: b.hash,
      embedding: vectors[idx]!,
      content: b.text,
      metadata: {
        repo: '',
        branch: '',
        timestamp: b.occurredAt,
        filePaths: [],
        exitCode: null,
        sessionId: b.doc.id,
        cwd: '',
        tier: 'raw',
        owner: b.doc.owner,
        trajectoryId: b.trajectoryId,
        chunkIndex: b.chunkIndex,
        chunkCount: b.chunkCount,
      },
    }));

    await deps.backend.upsert(chunks);
    embedded += chunks.length;
  }

  return { documents: docs.length, embedded, cacheHits, cacheMisses };
}
