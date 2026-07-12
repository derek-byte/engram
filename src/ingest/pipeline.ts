import { statSync } from 'node:fs';
import type { Chunk, EngramConfig, RawEvent } from '../types/index.ts';
import type { VectorBackend, WikiLedger } from '../storage/backend.ts';
import { LocalStore } from '../storage/local.ts';
import { DEFAULT_OWNER } from '../config/index.ts';
import { Embedder } from './embed.ts';
import { chunkHash, trajectoryHash } from './hash.ts';
import { chunkMessages, chunkTrajectory } from './chunker.ts';
import { buildCaptioner, resolveCaptions, type CaptionClient } from './caption.ts';
import { parseJsonl } from './parser.ts';

export interface PipelineDeps {
  // Vector store plus the tier/owner-scoped delete the V2 supersession cleanup
  // needs (both PgVectorBackend and the test FakeBackend implement WikiLedger).
  backend: VectorBackend & Pick<WikiLedger, 'deleteChunksByIds'>;
  embedder: Embedder;
  local: LocalStore;
  config: EngramConfig;
  // Owner stamped on raw events + chunks AND used for the supersession delete —
  // one value for all three, so a bench/alternate owner can never split-brain
  // against a hardcoded literal. Defaults to DEFAULT_OWNER.
  owner?: string;
  // Vision client for image captioning. undefined → built from config; null →
  // captioning explicitly off (all images get placeholders). Tests inject a fake.
  captioner?: CaptionClient | null;
}

export interface IngestResult {
  trajectories: number;
  embedded: number;
  skipped: number;
  cacheHits: number;
  cacheMisses: number;
  sessionId: string;
  repo: string;
}

export async function ingestFile(path: string, deps: PipelineDeps): Promise<IngestResult> {
  const owner = deps.owner ?? DEFAULT_OWNER;
  const client = deps.captioner === undefined ? buildCaptioner(deps.config) : deps.captioner;
  const messages = parseJsonl(path);
  // Image bytes travel here (sha256 → { mediaType, data }), NOT on the Trajectory
  // — so the raw_events payload can never carry base64.
  const imageData = new Map<string, { mediaType: string; data: string }>();
  const trajectories = chunkMessages(messages, imageData);
  if (trajectories.length === 0) {
    return { trajectories: 0, embedded: 0, skipped: 0, cacheHits: 0, cacheMisses: 0, sessionId: '', repo: '' };
  }

  const sessionId = trajectories[0]!.sessionId;
  const lastIndex = trajectories.length - 1;
  const state = deps.local.getCursorState(sessionId);
  // Reprocess from (and including) the last trajectory: content appended to the
  // final turn changes its hash but never the trajectory COUNT, so a count-based
  // cursor would slice it away and silently drop the new content (V2). Everything
  // before the cursor is settled; the last turn re-runs each ingest until a newer
  // turn supersedes it — unchanged chunks are free (hasSeen skips before embed).
  // Legacy rows (pre-wave-12) stored the trajectory COUNT and recorded no
  // last-turn identity; map count → index explicitly, because Math.min alone only
  // pulls a legacy cursor back when NOTHING was appended — one new turn since the
  // upgrade and the old final turn (which may have grown in place) is sliced away.
  const isLegacyCursor = state.lastTrajectoryId === null && state.chunkOffset > 0;
  const offset = isLegacyCursor ? state.chunkOffset - 1 : state.chunkOffset;
  const cursor = Math.min(offset, lastIndex);
  const fresh = trajectories.slice(cursor);

  // Resolve captions BEFORE chunkTrajectory (sync) so IMAGE: segments carry the
  // caption and chunkHash covers it. Never throws — failures become placeholders.
  // trajectoryHash is caption-independent, so this doesn't perturb supersession.
  await resolveCaptions(fresh, imageData, { cache: deps.backend, config: deps.config.imageCaption, client });

  // Supersession: the trajectory that sat at the cursor position last time was
  // the last turn then. If its content grew in place, its fresh trajectoryHash no
  // longer matches what we recorded, and its old raw chunks are now orphaned
  // duplicates — retract them (owner/tier-scoped) BEFORE upserting replacements.
  // New turns appended after it leave that trajectory's hash intact, so this does
  // NOT fire for growth-by-new-turn (those chunks stay, the new turn embeds).
  // Superseded raw_events rows are intentionally left (append-only journal), but
  // the deleted ids' seen-markers must go: hasSeen must imply present-in-backend,
  // or content that reverts to a prior state (external file restore, sync-conflict
  // overwrite) is skipped as seen with nothing left in the index.
  if (state.lastTrajectoryId && state.lastChunkIds.length) {
    const atCursor = trajectoryHash(trajectories[cursor]!);
    if (atCursor !== state.lastTrajectoryId) {
      await deps.backend.deleteChunksByIds(state.lastChunkIds, owner, 'raw');
      deps.local.forgetSeen(state.lastChunkIds);
    }
  }

  const toEmbed: Array<{
    text: string;
    hash: string;
    trajectory: (typeof trajectories)[number];
    trajectoryId: string;
    chunkIndex: number;
    chunkCount: number;
  }> = [];
  const rawEvents: RawEvent[] = [];
  let skipped = 0;

  // The last trajectory's identity + chunk ids, recorded after a successful
  // ingest so the next run can detect in-place growth of that turn.
  let lastTrajectoryId = state.lastTrajectoryId;
  let lastChunkIds = state.lastChunkIds;

  for (const t of fresh) {
    const trajectoryId = trajectoryHash(t);
    const texts = chunkTrajectory(t);
    const chunkCount = texts.length;
    const ids = texts.map((text, i) => chunkHash(trajectoryId, i, text));
    if (t === trajectories[lastIndex]) {
      lastTrajectoryId = trajectoryId;
      lastChunkIds = ids;
    }
    rawEvents.push({
      owner,
      source: 'claude-code',
      sessionId: t.sessionId,
      contentSha256: trajectoryId,
      occurredAt: t.timestamp,
      payload: t,
    });
    texts.forEach((text, chunkIndex) => {
      const hash = ids[chunkIndex]!;
      if (deps.local.hasSeen(hash)) {
        skipped++;
        return;
      }
      toEmbed.push({ text, hash, trajectory: t, trajectoryId, chunkIndex, chunkCount });
    });
  }

  await deps.backend.insertRawEvents(rawEvents);

  let embedded = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  for (let i = 0; i < toEmbed.length; i += deps.config.chunkBatchSize) {
    const batch = toEmbed.slice(i, i + deps.config.chunkBatchSize);
    const { embeddings: vectors, model: embeddingModel, ...stats } = await deps.embedder.embedWithStats(
      batch.map((b) => b.text),
      batch.map((b) => `${b.trajectory.sessionId} (${b.hash})`)
    );
    cacheHits += stats.cacheHits;
    cacheMisses += stats.cacheMisses;

    const chunks: Chunk[] = batch.map((b, idx) => ({
      id: b.hash,
      embedding: vectors[idx]!,
      content: b.text,
      metadata: {
        repo: b.trajectory.repo,
        branch: b.trajectory.branch,
        timestamp: b.trajectory.timestamp,
        filePaths: b.trajectory.filePaths,
        artifacts: b.trajectory.artifacts,
        exitCode: b.trajectory.exitCode,
        sessionId: b.trajectory.sessionId,
        cwd: b.trajectory.cwd,
        owner,
        tier: 'raw',
        trajectoryId: b.trajectoryId,
        chunkIndex: b.chunkIndex,
        chunkCount: b.chunkCount,
        embeddingModel,
      },
    }));

    await deps.backend.upsert(chunks);
    for (const b of batch) deps.local.markSeen(b.hash);
    embedded += chunks.length;
  }

  // Advance to the last trajectory's index (not the count) so the final turn is
  // re-examined next ingest. Record that turn's identity for the supersession
  // check — after this write the row is index-semantics and never re-enters the
  // legacy path above. Only runs after every batch upserted (a mid-file throw
  // leaves the cursor untouched — the crash-safety invariant).
  deps.local.setCursor(sessionId, lastIndex, lastTrajectoryId ?? undefined, lastChunkIds);
  deps.local.setStat('last_ingest_at', new Date().toISOString());

  return {
    trajectories: trajectories.length,
    embedded,
    skipped,
    cacheHits,
    cacheMisses,
    sessionId,
    repo: trajectories[0]!.repo,
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
