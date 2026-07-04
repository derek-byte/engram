import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { EngramConfig } from '../types/index.ts';
import { PROVIDER_DEFAULTS, type EmbeddingProviderKind } from '../ingest/embed.ts';
import { RERANK_DEFAULTS } from '../search/rerank.ts';

export const ENGRAM_DIR = join(homedir(), '.engram');
export const CONFIG_PATH = join(ENGRAM_DIR, 'config.json');
export const LOCAL_DB_PATH = process.env.ENGRAM_LOCAL_DB ?? join(ENGRAM_DIR, 'engram.sqlite');
export const LOG_PATH = join(ENGRAM_DIR, 'engram.log');

const DEFAULT_CONFIG: EngramConfig = {
  databaseUrl: '',
  openaiApiKey: '',
  embeddingProvider: 'local',
  embeddingModel: PROVIDER_DEFAULTS.local.model,
  embeddingDim: PROVIDER_DEFAULTS.local.dim,
  watchPath: join(homedir(), '.claude', 'projects'),
  sessionCompleteDelaySec: 8,
  chunkBatchSize: 32,
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  timeDecayHalfLifeDays: 0,
  rerank: RERANK_DEFAULTS,
  dreamModel: 'gpt-4o-mini',
  dreamMaxInputChars: 200_000,
  wikiDir: join(ENGRAM_DIR, 'wiki'),
  wikiModel: 'gpt-4o-mini',
  wikiMaxInputChars: 60_000,
  synthesis: { enabled: false, hour: 3 },
};

export function ensureEngramDir(): void {
  if (!existsSync(ENGRAM_DIR)) {
    mkdirSync(ENGRAM_DIR, { recursive: true });
  }
}

export function loadConfig(): EngramConfig {
  ensureEngramDir();
  const raw = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    : {};
  const merged: EngramConfig = { ...DEFAULT_CONFIG, ...raw };

  // rerank is a nested block; older config.json files lack it entirely.
  merged.rerank = { ...DEFAULT_CONFIG.rerank, ...(raw.rerank ?? {}) };
  const topK = Math.trunc(Number(merged.rerank.topK));
  merged.rerank.topK = Number.isFinite(topK) && topK >= 1 && topK <= 100 ? topK : RERANK_DEFAULTS.topK;

  // synthesis is a nested block too (older config.json files lack it); clamp hour to 0–23.
  merged.synthesis = { ...DEFAULT_CONFIG.synthesis, ...(raw.synthesis ?? {}) };
  const hour = Math.trunc(Number(merged.synthesis.hour));
  merged.synthesis.hour = Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_CONFIG.synthesis.hour;
  merged.synthesis.enabled = Boolean(merged.synthesis.enabled);

  // Env vars (incl. anything Bun auto-loads from .env) override the file.
  if (process.env.OPENAI_API_KEY) merged.openaiApiKey = process.env.OPENAI_API_KEY;
  if (process.env.ENGRAM_DATABASE_URL) merged.databaseUrl = process.env.ENGRAM_DATABASE_URL;
  if (process.env.ENGRAM_EMBEDDING_PROVIDER)
    merged.embeddingProvider = parseProvider(process.env.ENGRAM_EMBEDDING_PROVIDER);
  if (process.env.ENGRAM_DREAM_MODEL) merged.dreamModel = process.env.ENGRAM_DREAM_MODEL;
  if (process.env.ENGRAM_WIKI_DIR) merged.wikiDir = process.env.ENGRAM_WIKI_DIR;
  if (process.env.ENGRAM_WIKI_MODEL) merged.wikiModel = process.env.ENGRAM_WIKI_MODEL;

  // Model + dim follow the provider unless the file pinned them explicitly.
  // The local provider is fixed (buildProvider ignores pins for it), so pins —
  // including ones saveConfig persisted under openai — must not leak into a
  // local run and desync the pgvector column from the 384-dim vectors.
  if (merged.embeddingProvider === 'local') {
    merged.embeddingModel = PROVIDER_DEFAULTS.local.model;
    merged.embeddingDim = PROVIDER_DEFAULTS.local.dim;
  } else {
    if (raw.embeddingModel === undefined) merged.embeddingModel = PROVIDER_DEFAULTS.openai.model;
    if (raw.embeddingDim === undefined) merged.embeddingDim = PROVIDER_DEFAULTS.openai.dim;
  }

  return merged;
}

export function saveConfig(config: EngramConfig): void {
  ensureEngramDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function configIsComplete(config: EngramConfig): boolean {
  if (!config.databaseUrl) return false;
  // Local provider needs no API key; openai still runs keyless via local fallback.
  return config.embeddingProvider === 'local' ? true : Boolean(config.openaiApiKey);
}

function parseProvider(value: string): EmbeddingProviderKind {
  if (value === 'openai' || value === 'local') return value;
  throw new Error(`invalid ENGRAM_EMBEDDING_PROVIDER: ${value} (expected 'openai' or 'local')`);
}

export async function promptForMissing(config: EngramConfig): Promise<EngramConfig> {
  const next = { ...config };

  if (next.embeddingProvider === 'openai' && !next.openaiApiKey) {
    process.stdout.write('OpenAI API key (sk-...): ');
    next.openaiApiKey = (await readLine()).trim();
  }

  if (!next.databaseUrl) {
    process.stdout.write('Neon connection string (get one free at neon.tech): ');
    next.databaseUrl = (await readLine()).trim();
  }

  saveConfig(next);
  return next;
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      const nl = s.indexOf('\n');
      if (nl >= 0) {
        data += s.slice(0, nl);
        process.stdin.off('data', onData);
        process.stdin.pause();
        resolve(data);
      } else {
        data += s;
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
