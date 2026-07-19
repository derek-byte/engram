import { basename } from 'node:path';
import type { Artifact, Chunk, EmbeddedChunk, EngramConfig, RawEvent } from '../types/index.ts';
import type { DreamStore, DreamUnitRow, SynthesisUnit, VectorBackend } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';
import type { DreamLLM } from './llm.ts';
import { chunkHash, contentSha256 } from '../ingest/hash.ts';
import { CHARS_PER_TOKEN } from '../ingest/chunker.ts';
import { buildTranscript, buildUnitHeader } from './prompt.ts';

// Concurrent unit synthesis: each unit is one large LLM call (30-90s), so a
// serial backfill of N units takes N× that. Bounded to stay well inside
// OpenAI rate limits.
const DREAM_CONCURRENCY = 4;

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export interface SynthesizeParams {
  sourceOwner: string;
  dreamOwner: string;
  repo?: string;
  since?: Date;
  // Surgical scope to one session (watcher hook); omitted = all sessions.
  sessionId?: string;
  limit: number;
  dryRun: boolean;
}

export interface SynthesizeDeps {
  backend: DreamStore & Pick<VectorBackend, 'insertRawEvents' | 'upsert'>;
  embedder: Embedder;
  llm: DreamLLM;
  config: EngramConfig;
}

export interface UnitPlan {
  sessionId: string;
  repo: string;
  chunks: number;
  estTokens: number;
  status: 'new' | 'changed';
}

export interface SynthesizeResult {
  synthesized: number;
  dreamChunks: number;
  emptyUnits: number;
  skipped: number;
  deferred: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  dryRun: boolean;
  plan?: UnitPlan[];
  estTotalTokens?: number;
}

function unitKey(sessionId: string, repo: string): string {
  return `${sessionId}\n${repo}`;
}

export function fingerprintOf(unit: SynthesisUnit): string {
  // Sort defensively so the fingerprint is invariant to physical row order,
  // independent of whether the backend pre-sorted (SQL does; be robust anyway).
  // NOTE: artifacts must NEVER enter this input — the fingerprint gates the
  // dream/wiki re-synthesis short-circuit, so it stays a pure function of the
  // unit's chunk ids.
  return contentSha256([...unit.chunkIds].sort().join('\n'));
}

function artifactKey(a: Artifact): string {
  return `${a.kind}\n${a.tool}\n${a.ref}`;
}

// The de-duplicated union of every artifact carried on a unit's raw chunks.
function unionArtifacts(chunks: Chunk[]): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const c of chunks) {
    for (const a of c.metadata.artifacts ?? []) {
      const key = artifactKey(a);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

// Deterministic attachment: an artifact belongs to a dream item iff its
// identifying token appears VERBATIM in the item text — the file basename for
// kind 'file', the full URL for 'pr'/'url'. No fuzzy matching, no LLM: no match
// ⇒ no attachment (conservative on purpose).
function artifactsForText(text: string, unitArtifacts: Artifact[]): Artifact[] {
  return unitArtifacts.filter((a) => {
    const needle = a.kind === 'file' ? basename(a.ref) : a.ref;
    return needle.length > 0 && text.includes(needle);
  });
}

export async function synthesizeDreams(
  params: SynthesizeParams,
  deps: SynthesizeDeps
): Promise<SynthesizeResult> {
  const { backend, embedder, llm, config } = deps;

  const units = await backend.listSynthesisUnits({
    owner: params.sourceOwner,
    repo: params.repo,
    since: params.since,
    sessionId: params.sessionId,
  });

  const existing = new Map<string, DreamUnitRow>();
  for (const row of await backend.getDreamUnits(params.dreamOwner)) {
    existing.set(unitKey(row.sessionId, row.repo), row);
  }

  // Partition into changed/new (need work) vs unchanged (skipped for free).
  let skipped = 0;
  const pending: Array<{ unit: SynthesisUnit; fingerprint: string; status: 'new' | 'changed'; prior?: DreamUnitRow }> = [];
  for (const unit of units) {
    const fingerprint = fingerprintOf(unit);
    const prior = existing.get(unitKey(unit.sessionId, unit.repo));
    if (prior && prior.fingerprint === fingerprint) {
      skipped++;
      continue;
    }
    pending.push({ unit, fingerprint, status: prior ? 'changed' : 'new', prior });
  }

  const toProcess = pending.slice(0, Math.max(0, params.limit));
  const deferred = pending.length - toProcess.length;

  const capChars = config.dreamMaxInputChars;

  if (params.dryRun) {
    const plan: UnitPlan[] = toProcess.map(({ unit, status }) => ({
      sessionId: unit.sessionId,
      repo: unit.repo,
      chunks: unit.chunkIds.length,
      estTokens: Math.ceil(Math.min(unit.totalChars, capChars) / CHARS_PER_TOKEN),
      status,
    }));
    return {
      synthesized: 0,
      dreamChunks: 0,
      emptyUnits: 0,
      skipped,
      deferred,
      failed: 0,
      promptTokens: 0,
      completionTokens: 0,
      dryRun: true,
      plan,
      estTotalTokens: plan.reduce((s, p) => s + p.estTokens, 0),
    };
  }

  let synthesized = 0;
  let dreamChunks = 0;
  let emptyUnits = 0;
  let failed = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let completedUnits = 0;

  // Units are independent (distinct session/repo keys, trajectory ids, and
  // per-unit ledger rows), so their LLM calls run concurrently. Counter
  // mutation is safe: tasks interleave only at await points.
  const processUnit = async ({ unit, fingerprint, prior }: (typeof toProcess)[number]) => {
    try {
      const trajectoryId = `dream:${fingerprint}`;
      const rawChunks = await backend.getUnitChunks(params.sourceOwner, unit.sessionId, unit.repo);
      const unitArtifacts = unionArtifacts(rawChunks);
      const transcript = buildTranscript(rawChunks, capChars);
      const { items, usage } = await llm.extract(buildUnitHeader(unit), transcript);
      if (usage) {
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
      }

      const oldIds = prior?.dreamChunkIds ?? [];
      let newChunkIds: string[] = [];

      if (items.length > 0) {
        const texts = items.map((it) => it.text);
        const { embeddings, model } = await embedder.embedWithStats(
          texts,
          items.map((_, i) => `${trajectoryId}#${i}`)
        );
        const chunks: EmbeddedChunk[] = items.map((item, i) => ({
          id: chunkHash(trajectoryId, i, item.text),
          embedding: embeddings[i]!,
          content: item.text,
          metadata: {
            repo: unit.repo,
            branch: '',
            timestamp: unit.lastTimestamp,
            filePaths: [],
            exitCode: null,
            sessionId: unit.sessionId,
            cwd: '',
            tier: 'dream',
            dreamType: item.type,
            owner: params.dreamOwner,
            trajectoryId,
            chunkIndex: i,
            chunkCount: items.length,
            sourceChunkIds: unit.chunkIds,
            embeddingModel: model,
            artifacts: artifactsForText(item.text, unitArtifacts),
          },
        }));
        newChunkIds = chunks.map((c) => c.id);

        const rawEvent: RawEvent = {
          owner: params.dreamOwner,
          source: 'dream',
          sessionId: unit.sessionId,
          contentSha256: contentSha256(`${params.dreamOwner}\n${fingerprint}\n${JSON.stringify(items)}`),
          occurredAt: unit.lastTimestamp,
          payload: { sessionId: unit.sessionId, repo: unit.repo, fingerprint, items },
        };
        await backend.insertRawEvents([rawEvent]);
        await backend.upsert(chunks);
      }

      // Supersede stale dream chunks from a prior fingerprint (old minus new):
      // knowledge-level replacement → soft invalidation, not deletion, so a
      // content revert can resurrect them. supersededBy = the replacing dream
      // trajectory; an empty extraction leaves nothing to point at (null).
      const newSet = new Set(newChunkIds);
      const stale = oldIds.filter((id) => !newSet.has(id));
      await backend.invalidateDreamChunks(stale, params.dreamOwner, newChunkIds.length > 0 ? trajectoryId : null);

      // Fingerprint recorded LAST: a mid-unit failure leaves it unrecorded so
      // the unit retries next run; orphaned chunks are idempotent by id.
      await backend.upsertDreamUnit({
        owner: params.dreamOwner,
        sessionId: unit.sessionId,
        repo: unit.repo,
        fingerprint,
        sourceChunkIds: unit.chunkIds,
        dreamChunkIds: newChunkIds,
        model: config.dreamModel,
      });

      if (items.length > 0) {
        synthesized++;
        dreamChunks += newChunkIds.length;
      } else {
        emptyUnits++;
      }
    } catch (err) {
      failed++;
      console.error(
        `[dream] unit ${unit.sessionId}@${unit.repo || '(no repo)'} failed: ${err instanceof Error ? err.message : err}`
      );
    }
    completedUnits++;
    // Progress to stderr (stdout stays --json-clean).
    console.error(`[dream] ${completedUnits}/${toProcess.length} units · ${dreamChunks} dream chunks`);
  };
  await mapWithConcurrency(toProcess, DREAM_CONCURRENCY, processUnit);

  return {
    synthesized,
    dreamChunks,
    emptyUnits,
    skipped,
    deferred,
    failed,
    promptTokens,
    completionTokens,
    dryRun: false,
  };
}
