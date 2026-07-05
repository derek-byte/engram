import type { Artifact, ToolCall, Trajectory } from '../types/index.ts';
import { dedupeArtifacts, extractArtifacts } from './artifacts.ts';
import { repoFromCwd, type ContentBlock, type RawMessage } from './parser.ts';

export const CHUNKER_VERSION = 'v2';

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
    artifacts: Artifact[];
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
      artifacts: dedupeArtifacts(current.artifacts),
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
        artifacts: [],
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
          // File artifacts come from the tool INPUT (writer tools only).
          for (const a of extractArtifacts(block.name, block.input, undefined)) current.artifacts.push(a);
        }
      }
    } else if (m.type === 'user') {
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          const tc = current.pendingToolUses.get(block.toolUseId);
          if (tc) {
            // URL artifacts come from the FULL output, before truncation below.
            for (const a of extractArtifacts(tc.name, undefined, block.content)) current.artifacts.push(a);
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

// Token estimation is segment-type-aware: prose runs ~4 chars/token, but
// JSON-dense tool payloads tokenize ~30% heavier (~3 chars/token) — using the
// prose rate on tool chunks made v1 overshoot its target by ~30%.
export const CHARS_PER_TOKEN = 4;
export const TOOL_CHARS_PER_TOKEN = 3;
export const TARGET_TOKENS = 350;
const MAX_SEGMENT_TOKENS = 420; // 1.2 × target (v1 ratio preserved)
const OVERLAP_TOKENS = 42; // 0.12 × target (v1 ratio preserved)
export const HARD_CAP_TOKENS = 1750; // 5 × target (v1 ratio preserved)

export type SegmentKind = 'prose' | 'tool';

function charsPerToken(kind: SegmentKind): number {
  return kind === 'tool' ? TOOL_CHARS_PER_TOKEN : CHARS_PER_TOKEN;
}

// v2 packs role-homogeneously: USER/ASSISTANT prose never shares a chunk with
// TOOL call/result payloads, so embeddings stop being centroids of unrelated
// material. Order is preserved within each role class. Tool chunks carry a
// one-line USER context prefix so they embed with the trajectory's intent.
export function chunkTrajectory(t: Trajectory): string[] {
  const { prose, tool } = trajectorySegments(t);
  const chunks = packSegments(prose, 'prose');
  if (tool.length > 0) {
    const prefix = toolContextPrefix(t.userMessage);
    for (const c of packSegments(tool, 'tool')) {
      chunks.push(...hardSplit(`${prefix}\n${c}`, HARD_CAP_TOKENS, 'tool'));
    }
  }
  return chunks;
}

// Chunk arbitrary plain text (the generic-document / connector path): split on
// blank-line paragraph boundaries, then reuse the same token-aware packing.
// Whitespace-only content yields no chunks (empty strings are not embeddable).
export function chunkText(content: string): string[] {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return packSegments(paragraphs);
}

// Greedily pack semantic segments to ~TARGET_TOKENS with ~OVERLAP_TOKENS of
// carry-over, oversize segments hard-split first and the result capped at
// HARD_CAP_TOKENS so nothing ever exceeds the embedding limit.
export function packSegments(segments: string[], kind: SegmentKind = 'prose'): string[] {
  const split = segments.flatMap((s) => hardSplit(s, MAX_SEGMENT_TOKENS, kind));

  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;

  for (const seg of split) {
    const segTokens = estimateTokens(seg, kind);
    if (bufferTokens > OVERLAP_TOKENS && bufferTokens + segTokens > TARGET_TOKENS) {
      const text = buffer.join('\n');
      chunks.push(text);
      const overlap = overlapTail(text, kind);
      buffer = overlap ? [overlap] : [];
      bufferTokens = overlap ? estimateTokens(overlap, kind) : 0;
    }
    buffer.push(seg);
    bufferTokens += segTokens;
  }
  if (buffer.length > 0) chunks.push(buffer.join('\n'));

  return chunks.flatMap((c) => hardSplit(c, HARD_CAP_TOKENS, kind));
}

function trajectorySegments(t: Trajectory): { prose: string[]; tool: string[] } {
  const prose: string[] = [`USER: ${t.userMessage}`];
  for (const block of t.assistantBlocks) prose.push(`ASSISTANT: ${block}`);
  const tool: string[] = [];
  for (const tc of t.toolCalls) {
    let s = `TOOL ${tc.name}: ${safeJson(tc.input)}`;
    if (tc.output) s += `\nRESULT${tc.isError ? ' (error)' : ''}: ${tc.output}`;
    tool.push(s);
  }
  return { prose, tool };
}

// One-line intent prefix for tool chunks: the trajectory's user question,
// whitespace-collapsed and truncated to ~TOOL_PREFIX_MAX_CHARS.
export const TOOL_PREFIX_MAX_CHARS = 100;

export function toolContextPrefix(userMessage: string): string {
  const oneLine = userMessage.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= TOOL_PREFIX_MAX_CHARS) return `USER: ${oneLine}`;
  let cut = TOOL_PREFIX_MAX_CHARS;
  if (isHighSurrogate(oneLine.charCodeAt(cut - 1))) cut--;
  return `USER: ${oneLine.slice(0, cut)}…`;
}

function estimateTokens(s: string, kind: SegmentKind): number {
  return Math.ceil(s.length / charsPerToken(kind));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// How far back from the raw cut point to look for a newline/space before
// giving up and slicing mid-word.
const BACKOFF_WINDOW_CHARS = 200;

function hardSplit(s: string, maxTokens: number, kind: SegmentKind): string[] {
  const maxChars = maxTokens * charsPerToken(kind);
  if (s.length <= maxChars) return [s];
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + maxChars, s.length);
    if (end < s.length) {
      // Back off to the nearest newline/space in the window so we don't slice
      // mid-word; the separator stays on the left piece. windowStart >= i + 1
      // guarantees forward progress.
      const windowStart = Math.max(i + 1, end - BACKOFF_WINDOW_CHARS);
      const at = Math.max(s.lastIndexOf('\n', end - 1), s.lastIndexOf(' ', end - 1));
      if (at >= windowStart) end = at + 1;
      // Never split a surrogate pair: a high surrogate at the boundary means
      // the pair straddles the cut — move it whole to the next piece.
      else if (isHighSurrogate(s.charCodeAt(end - 1))) end--;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  // Belt-and-suspenders: never emit a lone surrogate even if the input itself
  // was malformed (toWellFormed replaces strays with U+FFFD).
  return out.map((p) => (p.isWellFormed() ? p : p.toWellFormed()));
}

export function overlapTail(text: string, kind: SegmentKind = 'prose'): string {
  const maxChars = OVERLAP_TOKENS * charsPerToken(kind);
  if (text.length <= maxChars) return text;
  let cut = text.length - maxChars;
  // Never start the overlap inside a surrogate pair.
  if (isLowSurrogate(text.charCodeAt(cut))) cut++;
  const tail = text.slice(cut);
  // Start the overlap on a clean boundary: prefer the first newline, then the
  // first space, so the carried tail never begins mid-line or mid-word.
  const nl = tail.indexOf('\n');
  if (nl >= 0 && nl < tail.length - 1) return tail.slice(nl + 1);
  const sp = tail.indexOf(' ');
  if (sp >= 0 && sp < tail.length - 1) return tail.slice(sp + 1);
  return tail;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
