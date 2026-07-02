export interface ChunkMetadata {
  repo: string;
  branch: string;
  timestamp: Date;
  filePaths: string[];
  exitCode: number | null;
  sessionId: string;
  cwd: string;
  tier: 'raw' | 'dream';
  trajectoryId?: string;
  chunkIndex?: number;
  chunkCount?: number;
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
  tier?: 'raw' | 'dream' | 'both';
  exitCode?: number;
  limit?: number;
}

export interface SearchResult {
  chunk: Chunk;
  similarity: number;
  keywordRank: number;
  combined: number;
}

export interface ScoringConfig {
  vectorWeight: number;
  keywordWeight: number;
  timeDecayHalfLifeDays: number;
}

export interface EngramConfig {
  databaseUrl: string;
  openaiApiKey: string;
  embeddingModel: string;
  embeddingDim: number;
  watchPath: string;
  sessionCompleteDelaySec: number;
  chunkBatchSize: number;
  vectorWeight: number;
  keywordWeight: number;
  timeDecayHalfLifeDays: number;
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
  exitCode: number | null;
}

export interface ToolCall {
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
}
