import { createHash } from 'node:crypto';
import type { Trajectory } from '../types/index.ts';

export function trajectoryHash(t: Trajectory): string {
  const normalized = normalize(
    [
      t.sessionId,
      t.userMessage,
      ...t.toolCalls.map((tc) => `${tc.name}:${stableJson(tc.input)}`),
      ...t.assistantBlocks,
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
