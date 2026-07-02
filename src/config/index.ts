import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { EngramConfig } from '../types/index.ts';
import { PROVIDER_DEFAULTS, type EmbeddingProviderKind } from '../ingest/embed.ts';

export const ENGRAM_DIR = join(homedir(), '.engram');
export const CONFIG_PATH = join(ENGRAM_DIR, 'config.json');
export const LOCAL_DB_PATH = join(ENGRAM_DIR, 'engram.sqlite');
export const LOG_PATH = join(ENGRAM_DIR, 'engram.log');

const DEFAULT_CONFIG: EngramConfig = {
  databaseUrl: '',
  openaiApiKey: '',
  embeddingProvider: 'openai',
  embeddingModel: PROVIDER_DEFAULTS.openai.model,
  embeddingDim: PROVIDER_DEFAULTS.openai.dim,
  watchPath: join(homedir(), '.claude', 'projects'),
  sessionCompleteDelaySec: 8,
  chunkBatchSize: 32,
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

  // Env vars (incl. anything Bun auto-loads from .env) override the file.
  if (process.env.OPENAI_API_KEY) merged.openaiApiKey = process.env.OPENAI_API_KEY;
  if (process.env.ENGRAM_DATABASE_URL) merged.databaseUrl = process.env.ENGRAM_DATABASE_URL;
  if (process.env.ENGRAM_EMBEDDING_PROVIDER)
    merged.embeddingProvider = parseProvider(process.env.ENGRAM_EMBEDDING_PROVIDER);

  // Model + dim follow the provider unless the file pinned them explicitly.
  const defaults = PROVIDER_DEFAULTS[merged.embeddingProvider];
  if (raw.embeddingModel === undefined) merged.embeddingModel = defaults.model;
  if (raw.embeddingDim === undefined) merged.embeddingDim = defaults.dim;

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
