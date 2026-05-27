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

export function trajectoryToText(t: Trajectory): string {
  const parts: string[] = [];
  parts.push(`USER: ${t.userMessage}`);
  if (t.assistantBlocks.length > 0) {
    parts.push(`ASSISTANT: ${t.assistantBlocks.join('\n')}`);
  }
  for (const tc of t.toolCalls) {
    parts.push(`TOOL ${tc.name}: ${safeJson(tc.input)}`);
    if (tc.output) parts.push(`RESULT${tc.isError ? ' (error)' : ''}: ${tc.output}`);
  }
  return parts.join('\n');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
