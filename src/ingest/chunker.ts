import type { ToolCall, Trajectory } from '../types/index.ts';
import { repoFromCwd, type ContentBlock, type RawMessage } from './parser.ts';

const FILE_PATH_TOOL_KEYS = ['file_path', 'path', 'notebook_path'];

export function chunkMessages(messages: RawMessage[]): Trajectory[] {
  const real = messages.filter((m) => !m.isMeta && !m.isSidechain);
  if (real.length === 0) return [];

  const trajectories: Trajectory[] = [];
  let current: {
    user: RawMessage;
    assistantBlocks: string[];
    toolCalls: ToolCall[];
    filePaths: Set<string>;
    pendingToolUses: Map<string, ToolCall>;
  } | null = null;

  const flush = () => {
    if (!current) return;
    const userText = current.user.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!userText) {
      current = null;
      return;
    }
    trajectories.push({
      sessionId: current.user.sessionId,
      repo: current.user.cwd ? repoFromCwd(current.user.cwd) : '',
      branch: current.user.branch ?? '',
      cwd: current.user.cwd ?? '',
      timestamp: current.user.timestamp,
      userMessage: userText,
      assistantBlocks: current.assistantBlocks,
      toolCalls: current.toolCalls,
      filePaths: [...current.filePaths],
      exitCode: null,
    });
    current = null;
  };

  for (const m of real) {
    if (m.type === 'user' && hasUserText(m.content)) {
      flush();
      current = {
        user: m,
        assistantBlocks: [],
        toolCalls: [],
        filePaths: new Set(),
        pendingToolUses: new Map(),
      };
      continue;
    }

    if (!current) continue;

    if (m.type === 'assistant') {
      for (const block of m.content) {
        if (block.type === 'text' && block.text.trim().length > 0) {
          current.assistantBlocks.push(block.text);
        } else if (block.type === 'tool_use') {
          const tc: ToolCall = { name: block.name, input: block.input };
          current.pendingToolUses.set(block.id, tc);
          current.toolCalls.push(tc);
          collectFilePaths(block.input, current.filePaths);
        }
      }
    } else if (m.type === 'user') {
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          const tc = current.pendingToolUses.get(block.toolUseId);
          if (tc) {
            tc.output = truncate(block.content, 2000);
            tc.isError = block.isError;
          }
        }
      }
    }
  }

  flush();
  return trajectories;
}

function hasUserText(content: ContentBlock[]): boolean {
  return content.some((b) => b.type === 'text' && b.text.trim().length > 0);
}

function collectFilePaths(input: unknown, into: Set<string>): void {
  if (!input || typeof input !== 'object') return;
  const obj = input as Record<string, unknown>;
  for (const key of FILE_PATH_TOOL_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) into.add(v);
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `... [truncated ${s.length - max} chars]`;
}

const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 1000;
const MAX_SEGMENT_TOKENS = 1200;
const OVERLAP_TOKENS = 120;
const HARD_CAP_TOKENS = 5000;

export function chunkTrajectory(t: Trajectory): string[] {
  const segments = trajectorySegments(t).flatMap((s) => hardSplit(s, MAX_SEGMENT_TOKENS));

  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;

  for (const seg of segments) {
    const segTokens = estimateTokens(seg);
    if (buffer.length > 0 && bufferTokens + segTokens > TARGET_TOKENS) {
      const text = buffer.join('\n');
      chunks.push(text);
      const overlap = overlapTail(text);
      buffer = overlap ? [overlap] : [];
      bufferTokens = overlap ? estimateTokens(overlap) : 0;
    }
    buffer.push(seg);
    bufferTokens += segTokens;
  }
  if (buffer.length > 0) chunks.push(buffer.join('\n'));

  return chunks.flatMap((c) => hardSplit(c, HARD_CAP_TOKENS));
}

function trajectorySegments(t: Trajectory): string[] {
  const segments: string[] = [`USER: ${t.userMessage}`];
  for (const block of t.assistantBlocks) segments.push(`ASSISTANT: ${block}`);
  for (const tc of t.toolCalls) {
    let s = `TOOL ${tc.name}: ${safeJson(tc.input)}`;
    if (tc.output) s += `\nRESULT${tc.isError ? ' (error)' : ''}: ${tc.output}`;
    segments.push(s);
  }
  return segments;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function hardSplit(s: string, maxTokens: number): string[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (s.length <= maxChars) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
  return out;
}

function overlapTail(text: string): string {
  const maxChars = OVERLAP_TOKENS * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const tail = text.slice(text.length - maxChars);
  const nl = tail.indexOf('\n');
  return nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
