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

export function parseJsonl(path: string): RawMessage[] {
  const text = readFileSync(path, 'utf-8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const out: RawMessage[] = [];

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
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
