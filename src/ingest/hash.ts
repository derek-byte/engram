import { createHash } from 'node:crypto';
import type { Trajectory } from '../types/index.ts';

export function contentSha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function trajectoryHash(t: Trajectory): string {
  const normalized = normalize(
    [
      t.sessionId,
      t.userMessage,
      ...t.toolCalls.map((tc) => `${tc.name}:${stableJson(tc.input)}`),
      ...t.assistantBlocks,
      // Thinking IS hashed: it changes chunk text, so an unchanged hash would
      // leave the old chunks as un-superseded duplicates. Image sha256s enter
      // too; caption text and base64 never do (captions affect chunkHash only).
      // Empty arrays append nothing, so a no-thinking/no-image trajectory hashes
      // byte-identically to the pre-wave composition — the corpus doesn't churn.
      ...t.thinkingBlocks,
      ...t.images.map((i) => `image:${i.sha256}`),
    ].join('\n')
  );
  return createHash('sha256').update(normalized).digest('hex');
}

export function chunkHash(trajectoryId: string, index: number, content: string): string {
  return createHash('sha256').update(`${trajectoryId}:${index}:${normalize(content)}`).digest('hex');
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson((v as Record<string, unknown>)[k])).join(',') + '}';
}
