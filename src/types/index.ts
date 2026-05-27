export interface ChunkMetadata {
  repo: string;
  branch: string;
  timestamp: Date;
  filePaths: string[];
  exitCode: number | null;
  sessionId: string;
  cwd: string;
  tier: 'raw' | 'dream';
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
}

export interface EngramConfig {
  databaseUrl: string;
  openaiApiKey: string;
  embeddingModel: string;
  embeddingDim: number;
  watchPath: string;
  sessionCompleteDelaySec: number;
  chunkBatchSize: number;
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
