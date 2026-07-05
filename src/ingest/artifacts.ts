import type { Artifact, ToolCall } from '../types/index.ts';

export type { Artifact };

// At most this many distinct artifacts are kept per trajectory — a hard bound so
// a pathological transcript (thousands of URLs in one output) can't bloat metadata.
export const MAX_ARTIFACTS = 20;

// Writer tools whose inputs *produce* a file. Read/Grep/Glob consume paths rather
// than producing them, so they are deliberately excluded (exact-name allowlist).
const WRITER_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_INPUT_KEYS = ['file_path', 'path', 'notebook_path'];

// Matches a URL up to the first whitespace/quote/bracket — same shape as a bare
// URL printed on its own line (e.g. `gh pr create` output).
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
// A github.com pull-request permalink → kind 'pr'.
const PR_RE = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
// Hosts that are never durable artifacts: loopback and the embedding API.
const HOST_DENYLIST = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'api.openai.com']);

// Deterministically extract artifacts from ONE tool interaction:
//   - files from writer-tool inputs (file_path|path|notebook_path)
//   - URLs from the tool output (never from assistant text)
// input and output are supplied independently because they surface at different
// points in the message stream (tool_use vs tool_result); pass `undefined` for
// the side that isn't present. Dedup + capping is applied by dedupeArtifacts.
export function extractArtifacts(toolName: string, input: unknown, output: string | undefined): Artifact[] {
  const out: Artifact[] = [];
  const seen = new Set<string>();

  if (WRITER_TOOLS.has(toolName) && input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of FILE_INPUT_KEYS) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0 && !seen.has(v)) {
        seen.add(v);
        out.push({ kind: 'file', ref: v, tool: toolName });
      }
    }
  }

  if (output) {
    // matchAll (lazy) + early exit: a pathological multi-MB output dense with
    // URLs must not materialize an unbounded match array or blow a spread later.
    for (const m of output.matchAll(URL_RE)) {
      if (out.length >= MAX_ARTIFACTS) break;
      const ref = m[0];
      if (seen.has(ref)) continue;
      const host = hostOf(ref);
      if (host === null || HOST_DENYLIST.has(host)) continue;
      seen.add(ref);
      out.push({ kind: PR_RE.test(ref) ? 'pr' : 'url', ref, tool: toolName });
    }
  }

  return out;
}

// Dedup by ref (first occurrence wins), then cap at MAX_ARTIFACTS.
export function dedupeArtifacts(artifacts: Artifact[]): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const a of artifacts) {
    if (seen.has(a.ref) || out.length >= MAX_ARTIFACTS) continue;
    seen.add(a.ref);
    out.push(a);
  }
  return out;
}

// Whole-trajectory extraction over a ToolCall[] — used by the backfill sweep,
// where the payload's tool outputs are already truncated (acceptable). Live
// ingestion instead hooks extractArtifacts inline in chunkMessages so it sees the
// untruncated output.
export function collectArtifacts(toolCalls: ToolCall[]): Artifact[] {
  const all: Artifact[] = [];
  for (const tc of toolCalls) {
    for (const a of extractArtifacts(tc.name, tc.input, tc.output)) all.push(a);
  }
  return dedupeArtifacts(all);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
