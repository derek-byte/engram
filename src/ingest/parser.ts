import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface RawMessage {
  uuid: string;
  parentUuid: string | null;
  type: string;
  role?: 'user' | 'assistant';
  content: ContentBlock[];
  timestamp: Date;
  cwd?: string;
  branch?: string;
  sessionId: string;
  isMeta?: boolean;
  isSidechain?: boolean;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown; id: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export function decodeProjectDir(dirName: string): string {
  return dirName.startsWith('-') ? '/' + dirName.slice(1).replace(/-/g, '/') : dirName;
}

export function repoFromCwd(cwd: string): string {
  return basename(cwd);
}

// JSON legally carries \u0000 and lone-surrogate escapes, so JSON.parse yields
// real NUL chars / ill-formed UTF-16 strings — both fatal downstream: Postgres
// jsonb (raw_events payload) rejects \u0000 with "unsupported Unicode escape
// sequence", and chunks.content (TEXT) can't hold 0x00. Replace both with U+FFFD.
// The fast-path returns the input byte-identical so clean strings never churn.
export function sanitizeUnicode(s: string): string {
  if (!s.includes('\u0000') && s.isWellFormed()) return s;
  return s.replaceAll('\u0000', '\uFFFD').toWellFormed();
}

// Recursively sanitize every string value AND object key (a NUL in a key
// round-trips into jsonb too); rebuild an object/array only when something
// changed, so a clean line passes through unchanged (no re-chunk/re-embed churn).
function deepSanitize(v: unknown): unknown {
  if (typeof v === 'string') return sanitizeUnicode(v);
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const s = deepSanitize(x);
      if (s !== x) changed = true;
      return s;
    });
    return changed ? out : v;
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const sk = sanitizeUnicode(k);
      const sv = deepSanitize(val);
      if (sk !== k || sv !== val) changed = true;
      out[sk] = sv;
    }
    return changed ? out : v;
  }
  return v;
}

export function parseJsonl(path: string): RawMessage[] {
  const text = readFileSync(path, 'utf-8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const out: RawMessage[] = [];

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = deepSanitize(JSON.parse(line)) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type as string | undefined;
    if (!type) continue;
    if (type !== 'user' && type !== 'assistant') continue;

    const message = obj.message as { role?: string; content?: unknown } | undefined;
    if (!message) continue;

    const content = normalizeContent(message.content);
    if (content.length === 0) continue;

    const timestamp = obj.timestamp ? new Date(obj.timestamp as string) : new Date();

    out.push({
      uuid: (obj.uuid as string) ?? '',
      parentUuid: (obj.parentUuid as string | null) ?? null,
      type,
      role: message.role as 'user' | 'assistant' | undefined,
      content,
      timestamp,
      cwd: obj.cwd as string | undefined,
      branch: obj.gitBranch as string | undefined,
      sessionId: (obj.sessionId as string) ?? '',
      isMeta: obj.isMeta === true,
      isSidechain: obj.isSidechain === true,
    });
  }

  return out;
}

function normalizeContent(raw: unknown): ContentBlock[] {
  if (typeof raw === 'string') {
    return raw.length > 0 ? [{ type: 'text', text: raw }] : [];
  }
  if (!Array.isArray(raw)) return [];

  const out: ContentBlock[] = [];
  for (const block of raw) {
    if (!block || typeof block !== 'object') continue;
    const t = (block as Record<string, unknown>).type;
    if (t === 'text') {
      const text = (block as { text?: string }).text;
      if (typeof text === 'string' && text.length > 0) {
        out.push({ type: 'text', text });
      }
    } else if (t === 'tool_use') {
      const b = block as { name?: string; input?: unknown; id?: string };
      out.push({ type: 'tool_use', name: b.name ?? '', input: b.input, id: b.id ?? '' });
    } else if (t === 'tool_result') {
      const b = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
      const contentStr = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      out.push({ type: 'tool_result', toolUseId: b.tool_use_id ?? '', content: contentStr, isError: b.is_error });
    }
  }
  return out;
}
