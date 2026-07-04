import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { EngramConfig } from '../types/index.ts';
import { PROVIDER_DEFAULTS, type EmbeddingProviderKind } from '../ingest/embed.ts';
import { RERANK_DEFAULTS } from '../search/rerank.ts';

export const CONTEXT_BUDGET_DEFAULT = 1500;
export const CONTEXT_BUDGET_MIN = 100;
export const CONTEXT_BUDGET_MAX = 20000;

export const SYNTHESIS_HOUR_MIN = 0;
export const SYNTHESIS_HOUR_MAX = 23;
export const SYNTHESIS_HOUR_DEFAULT = 3;

export const ENGRAM_DIR = join(homedir(), '.engram');
export const CONFIG_PATH = join(ENGRAM_DIR, 'config.json');

// Config reads/writes resolve the path lazily so a test can redirect them at a
// scratch file via ENGRAM_CONFIG_PATH — the settings route patches config.json
// in place, and no test may ever touch the real ~/.engram/config.json.
function resolveConfigPath(): string {
  return process.env.ENGRAM_CONFIG_PATH ?? CONFIG_PATH;
}
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
  synthesis: { enabled: false, hour: SYNTHESIS_HOUR_DEFAULT },
  contextInjection: { enabled: true, budget: CONTEXT_BUDGET_DEFAULT },
};

export function ensureEngramDir(): void {
  if (!existsSync(ENGRAM_DIR)) {
    mkdirSync(ENGRAM_DIR, { recursive: true });
  }
}

export function loadConfig(): EngramConfig {
  ensureEngramDir();
  const path = resolveConfigPath();
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
  return mergeConfig(raw, process.env);
}

// Pure merge of a parsed config.json over defaults (exported for tests).
export function mergeConfig(
  raw: Partial<EngramConfig> & Record<string, unknown>,
  env: Record<string, string | undefined> = {}
): EngramConfig {
  const merged: EngramConfig = { ...DEFAULT_CONFIG, ...raw };

  // rerank is a nested block; older config.json files lack it entirely.
  merged.rerank = { ...DEFAULT_CONFIG.rerank, ...(raw.rerank ?? {}) };
  const topK = Math.trunc(Number(merged.rerank.topK));
  merged.rerank.topK = Number.isFinite(topK) && topK >= 1 && topK <= 100 ? topK : RERANK_DEFAULTS.topK;

  // synthesis is a nested block too (older config.json files lack it); clamp hour to 0–23.
  merged.synthesis = { ...DEFAULT_CONFIG.synthesis, ...(raw.synthesis ?? {}) };
  merged.synthesis.hour = clampHour(merged.synthesis.hour, DEFAULT_CONFIG.synthesis.hour);
  merged.synthesis.enabled = Boolean(merged.synthesis.enabled);

  // contextInjection is a nested block (older config.json files lack it); clamp budget.
  merged.contextInjection = { ...DEFAULT_CONFIG.contextInjection, ...(raw.contextInjection ?? {}) };
  merged.contextInjection.budget = clampContextBudget(merged.contextInjection.budget, CONTEXT_BUDGET_DEFAULT);
  merged.contextInjection.enabled = Boolean(merged.contextInjection.enabled);

  // Env vars (incl. anything Bun auto-loads from .env) override the file.
  if (env.OPENAI_API_KEY) merged.openaiApiKey = env.OPENAI_API_KEY;
  if (env.ENGRAM_DATABASE_URL) merged.databaseUrl = env.ENGRAM_DATABASE_URL;
  if (env.ENGRAM_EMBEDDING_PROVIDER)
    merged.embeddingProvider = parseProvider(env.ENGRAM_EMBEDDING_PROVIDER);
  if (env.ENGRAM_DREAM_MODEL) merged.dreamModel = env.ENGRAM_DREAM_MODEL;
  if (env.ENGRAM_WIKI_DIR) merged.wikiDir = env.ENGRAM_WIKI_DIR;
  if (env.ENGRAM_WIKI_MODEL) merged.wikiModel = env.ENGRAM_WIKI_MODEL;

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
  writeFileSync(resolveConfigPath(), JSON.stringify(config, null, 2));
}

// The keys the settings UI may edit. Secrets (openaiApiKey, databaseUrl) and
// structural fields (watchPath, embeddingDim, …) are deliberately excluded — the
// config route rejects anything outside this set.
export const EDITABLE_CONFIG_KEYS = [
  'embeddingProvider',
  'dreamModel',
  'wikiModel',
  'rerank',
  'synthesis',
  'contextInjection',
] as const;
export type EditableConfigKey = (typeof EDITABLE_CONFIG_KEYS)[number];

// Raw parse of config.json with NO env folding or default merge — the on-disk
// truth. patchConfigFile edits this so env secrets never leak back into the file.
export function readConfigFile(): Record<string, unknown> {
  ensureEngramDir();
  const path = resolveConfigPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

// A PUT body that names an editable key but carries the wrong shape (a string
// where an object belongs, an object where a model name belongs). The config
// route maps this to a 400 — it must never become a 500 or a silent bad write.
export class ConfigPatchError extends Error {}

function requirePlainObject(key: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigPatchError(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

// Patch config.json in place: deep-merge only the editable keys over the on-disk
// file, clamp bounded values, and write back. This must NOT route through
// saveConfig(loadConfig()) — loadConfig folds in env secrets (OPENAI_API_KEY, the
// Neon URL) and provider-derived defaults, which would then get baked into the
// file. Unknown keys already in the file are preserved verbatim. Returns the raw
// file object after the patch.
export function patchConfigFile(patch: Record<string, unknown>): Record<string, unknown> {
  const raw = readConfigFile();

  for (const key of EDITABLE_CONFIG_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    switch (key) {
      case 'embeddingProvider':
        raw.embeddingProvider = parseProvider(String(value));
        break;
      case 'dreamModel':
      case 'wikiModel': {
        if (typeof value !== 'string' || value.trim() === '') {
          throw new ConfigPatchError(`${key} must be a non-empty string`);
        }
        raw[key] = value.trim();
        break;
      }
      case 'rerank': {
        // Only the enabled toggle is editable; model/topK stay whatever the file holds.
        const v = requirePlainObject(key, value);
        const cur = (raw.rerank ?? {}) as Record<string, unknown>;
        raw.rerank = { ...cur, enabled: Boolean(v.enabled) };
        break;
      }
      case 'synthesis': {
        const v = requirePlainObject(key, value);
        const cur = (raw.synthesis ?? {}) as Record<string, unknown>;
        if ('enabled' in v) cur.enabled = Boolean(v.enabled);
        if ('hour' in v) cur.hour = clampHour(v.hour, SYNTHESIS_HOUR_DEFAULT);
        raw.synthesis = cur;
        break;
      }
      case 'contextInjection': {
        const v = requirePlainObject(key, value);
        const cur = (raw.contextInjection ?? {}) as Record<string, unknown>;
        if ('enabled' in v) cur.enabled = Boolean(v.enabled);
        if ('budget' in v) cur.budget = clampContextBudget(v.budget, CONTEXT_BUDGET_DEFAULT);
        raw.contextInjection = cur;
        break;
      }
    }
  }

  ensureEngramDir();
  writeFileSync(resolveConfigPath(), JSON.stringify(raw, null, 2));
  return raw;
}

export function configIsComplete(config: EngramConfig): boolean {
  if (!config.databaseUrl) return false;
  // Local provider needs no API key; openai still runs keyless via local fallback.
  return config.embeddingProvider === 'local' ? true : Boolean(config.openaiApiKey);
}

// Shared by loadConfig (config.json) and `engram context --budget` (CLI flag).
export function clampContextBudget(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(CONTEXT_BUDGET_MAX, Math.max(CONTEXT_BUDGET_MIN, n));
}

// Shared by loadConfig and patchConfigFile — clamp synthesis hour to 0–23.
export function clampHour(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= SYNTHESIS_HOUR_MIN && n <= SYNTHESIS_HOUR_MAX ? n : fallback;
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
