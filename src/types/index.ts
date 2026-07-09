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
}

export interface RerankConfig {
  enabled: boolean;
  model: string;
  topK: number;
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
  rerank: RerankConfig;
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

export interface Trajectory {
  sessionId: string;
  repo: string;
  branch: string;
  cwd: string;
  timestamp: Date;
  userMessage: string;
  assistantBlocks: string[];
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
