import type { ImageCaptionConfig, RerankConfig } from '../types/index.ts';

// Feature defaults live here, with config — a leaf module importing only from
// src/types/ so feature dirs (ingest, search, …) import downward and config
// never reaches up into them.

export const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';
export const OPENAI_DEFAULT_DIM = 1536;
export const LOCAL_MODEL = 'all-MiniLM-L6-v2';
export const LOCAL_DIM = 384;

export type EmbeddingProviderKind = 'openai' | 'local';

export const PROVIDER_DEFAULTS: Record<EmbeddingProviderKind, { model: string; dim: number }> = {
  openai: { model: OPENAI_DEFAULT_MODEL, dim: OPENAI_DEFAULT_DIM },
  local: { model: LOCAL_MODEL, dim: LOCAL_DIM },
};

export const RERANK_DEFAULTS: RerankConfig = { enabled: false, model: 'gpt-4.1-mini', topK: 30 };

// Mirrors RERANK_DEFAULTS: on by default, but every path is fail-safe — no key,
// disabled config, or LLM error → placeholder caption, never a throw.
export const IMAGE_CAPTION_DEFAULTS: ImageCaptionConfig = {
  enabled: true,
  model: 'gpt-4o-mini',
  maxPerTrajectory: 4,
};
