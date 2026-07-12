// Stamps every stored chunk; bump it when chunking semantics change to trigger re-indexing.
export const CHUNKER_VERSION = 'v3';

// A durable output a trajectory produced (a written file, a PR, a URL). Extracted
// deterministically from tool inputs/outputs — see ingest/artifacts.ts.
export interface Artifact {
  kind: 'file' | 'pr' | 'url';
  ref: string;
  tool: string;
}

export interface ChunkMetadata {
  repo: string;
  branch: string;
  timestamp: Date;
  filePaths: string[];
  exitCode: number | null;
  sessionId: string;
  cwd: string;
  tier: 'raw' | 'dream' | 'wiki';
  owner?: string;
  trajectoryId?: string;
  chunkIndex?: number;
  chunkCount?: number;
  embeddingModel?: string;
  dreamType?: string;
  sourceChunkIds?: string[];
  artifacts?: Artifact[];
  // Supersession tombstone: set when this chunk was soft-invalidated (knowledge
  // replaced by a dream re-synthesis or wiki cleanup). Live reads filter these
  // out; supersededBy names the trajectory that replaced it (null = orphaned).
  invalidAt?: Date;
  supersededBy?: string | null;
}

export interface Chunk {
  id: string;
  embedding: number[];
  content: string;
  metadata: ChunkMetadata;
}

export interface SearchFilters {
  repo?: string;
  branch?: string;
  since?: Date;
  // 'synth' = wiki+dream; 'all' = no tier filter; 'both' is a deprecated alias of 'all'.
  tier?: 'raw' | 'dream' | 'wiki' | 'synth' | 'all' | 'both';
  exitCode?: number;
  owner?: string;
  limit?: number;
  // Force an exact (seq-scan) search instead of the HNSW approximation — needed
  // when a selective filter (e.g. owner) would starve the ANN candidate set.
  exhaustive?: boolean;
  // Opt-in to see invalidated (superseded) chunks in results; default false
  // (live-only). Only the CLI plumbs this; MCP/UI stay live-only.
  includeSuperseded?: boolean;
}

export interface SearchResult {
  chunk: Chunk;
  similarity: number;
  keywordRank: number;
  combined: number;
  // 1-based position assigned by the LLM reranker. Absent when rerank didn't
  // run or the LLM omitted this chunk from its ranking.
  rerankRank?: number;
}

export interface ScoringConfig {
  vectorWeight: number;
  keywordWeight: number;
  timeDecayHalfLifeDays: number;
  // Additive recency prior: exp-decay of chunk age over recencyHalfLifeDays,
  // bounded [0,1]. 0 half-life disables it. Distinct from timeDecayHalfLifeDays
  // (a multiplicative decay wrapping the whole score).
  recencyWeight: number;
  recencyHalfLifeDays: number;
  // Additive tier-importance prior (Generative-Agents-style): wiki > dream > raw.
  importanceWeight: number;
}

export interface RerankConfig {
  enabled: boolean;
  model: string;
  topK: number;
}

export interface ImageCaptionConfig {
  enabled: boolean;
  model: string;
  maxPerTrajectory: number;
}

export interface SynthesisConfig {
  enabled: boolean;
  hour: number;
  targetedSessionsPerNight: number;
}

export interface ContextInjectionConfig {
  enabled: boolean;
  budget: number;
}

export interface EngramConfig {
  databaseUrl: string;
  openaiApiKey: string;
  embeddingProvider: 'openai' | 'local';
  embeddingModel: string;
  embeddingDim: number;
  watchPath: string;
  sessionCompleteDelaySec: number;
  chunkBatchSize: number;
  vectorWeight: number;
  keywordWeight: number;
  timeDecayHalfLifeDays: number;
  recencyWeight: number;
  recencyHalfLifeDays: number;
  importanceWeight: number;
  rerank: RerankConfig;
  imageCaption: ImageCaptionConfig;
  dreamModel: string;
  dreamMaxInputChars: number;
  wikiDir: string;
  wikiModel: string;
  wikiMaxInputChars: number;
  // Model for the ask surface (CLI/MCP/UI). Empty string = follow wikiModel,
  // which was the behavior before this key existed.
  askModel: string;
  synthesis: SynthesisConfig;
  contextInjection: ContextInjectionConfig;
}

export interface RawEvent {
  owner?: string;
  source: string;
  sessionId: string;
  contentSha256: string;
  occurredAt: Date;
  payload: unknown;
}

// An image referenced by a trajectory. The base64 bytes never live here — they
// travel in a side-channel Map (sha256 → { mediaType, data }) so the Trajectory
// (persisted verbatim as the raw_events payload) is structurally incapable of
// carrying image bytes. sha256 enters the trajectoryHash; caption never does.
export interface TrajectoryImage {
  sha256: string; // sha256 hex over the DECODED bytes (Buffer.from(data,'base64'))
  mediaType: string; // e.g. 'image/png'
  bytes: number; // decoded byte length
  caption: string; // '' until the pipeline resolves it
}

export interface Trajectory {
  sessionId: string;
  repo: string;
  branch: string;
  cwd: string;
  timestamp: Date;
  userMessage: string;
  assistantBlocks: string[];
  thinkingBlocks: string[];
  images: TrajectoryImage[];
  toolCalls: ToolCall[];
  filePaths: string[];
  artifacts: Artifact[];
  exitCode: number | null;
}

export interface ToolCall {
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
}
