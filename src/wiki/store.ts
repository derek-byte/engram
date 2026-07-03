import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { contentSha256 } from '../ingest/hash.ts';
import { buildLinkGraph, isValidSlug, parseWikilinks, type LinkGraph } from './links.ts';

export const PAGE_KINDS = ['project', 'decision', 'gotcha', 'tool', 'person', 'topic'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const PAGE_SCHEMA = 1;

export interface WikiPage {
  slug: string;
  schema: number;
  title: string;
  kind: PageKind;
  summary: string;
  aliases: string[];
  sources: string[]; // dream-chunk ids (provenance, monotonically merged)
  trajectories: string[]; // dream trajectory ids ('dream:<unit fp>')
  fingerprint: string; // sha256 of sorted sources
  created: string;
  updated: string;
  body: string;
}

// sha256 of a page's sorted source ids — the per-page compile fingerprint.
export function pageFingerprint(sources: string[]): string {
  return contentSha256([...sources].sort().join('\n'));
}

const FRONTMATTER_KEYS = [
  'schema',
  'title',
  'kind',
  'summary',
  'aliases',
  'sources',
  'trajectories',
  'fingerprint',
  'created',
  'updated',
] as const;

// The human/model contract, written to <wikiDir>/SCHEMA.md on init.
const SCHEMA_MD = `# engram wiki — schema (v${PAGE_SCHEMA})

This directory is **model-owned**. \`engram wiki ingest\` compiles dream-tier
memory (L1) into these pages (L2). Humans rarely edit pages by hand; the graph
is the product.

## Layout

- \`pages/<slug>.md\` — one entity/topic per file. Slug is kebab-case, \`^[a-z0-9-]{1,64}$\`.
- \`index.md\` — regenerated deterministically from every page's frontmatter on each ingest. Do not edit.
- \`SCHEMA.md\` — this file.

## Frontmatter (YAML, \`schema: ${PAGE_SCHEMA}\`)

\`\`\`yaml
schema: ${PAGE_SCHEMA}
title: Fingerprint short-circuit
kind: project | decision | gotcha | tool | person | topic
summary: one line used by index.md and the LLM inventory
aliases: [fingerprint-skip]
sources: [<dream chunk id>, ...]        # provenance, only ever grows via ingest
trajectories: [dream:<unit fp>, ...]    # raw drill-down overlay
fingerprint: <sha256 of sorted sources>
created: <ISO>
updated: <ISO>
\`\`\`

## Rules

- Every page links the entities it mentions as \`[[slug]]\` or \`[[slug|label]]\`. Value is in the edges.
- Reuse existing slugs — never mint a near-duplicate. Lint surfaces orphans, dangling links, and spelling drift.
- Provenance (\`sources\`, \`trajectories\`) is append-only. The pg index (\`tier='wiki'\`) is derived and rebuildable via \`engram wiki reindex\`.
`;

// Filesystem-backed wiki store. Files are the source of truth; pg is derived.
export class WikiStore {
  readonly dir: string;
  readonly pagesDir: string;
  readonly indexPath: string;
  readonly schemaPath: string;

  constructor(wikiDir: string) {
    const abs = resolve(wikiDir);
    if (!isAbsolute(wikiDir) || abs === '/' || abs === resolve(homedir())) {
      throw new Error(`unsafe wikiDir: ${wikiDir} (must be an absolute path, not / or the home dir)`);
    }
    this.dir = abs;
    this.pagesDir = join(abs, 'pages');
    this.indexPath = join(abs, 'index.md');
    this.schemaPath = join(abs, 'SCHEMA.md');
  }

  // Create the dir + pages/ + SCHEMA.md if absent, and git-init so every ingest
  // can commit (a bad rewrite is one `git revert` away).
  init(): void {
    if (!existsSync(this.pagesDir)) mkdirSync(this.pagesDir, { recursive: true });
    if (!existsSync(this.schemaPath)) writeFileSync(this.schemaPath, SCHEMA_MD);
    if (!existsSync(join(this.dir, '.git'))) {
      this.git(['init', '-q']);
      this.git(['config', 'user.email', 'engram@local']);
      this.git(['config', 'user.name', 'engram']);
    }
  }

  pagePath(slug: string): string {
    return join(this.pagesDir, `${slug}.md`);
  }

  // All page slugs on disk (files under pages/ named <slug>.md with a valid slug).
  listSlugs(): string[] {
    if (!existsSync(this.pagesDir)) return [];
    return readdirSync(this.pagesDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .filter(isValidSlug)
      .sort();
  }

  // Read + parse a page, or null if absent. Throws on malformed frontmatter so
  // callers can surface it (lint) rather than silently mis-render.
  readPage(slug: string): WikiPage | null {
    const path = this.pagePath(slug);
    if (!existsSync(path)) return null;
    return parsePage(slug, readFileSync(path, 'utf-8'));
  }

  listPages(): WikiPage[] {
    const out: WikiPage[] = [];
    for (const slug of this.listSlugs()) {
      const p = this.readPage(slug);
      if (p) out.push(p);
    }
    return out;
  }

  writePage(page: WikiPage): void {
    if (!existsSync(this.pagesDir)) mkdirSync(this.pagesDir, { recursive: true });
    writeFileSync(this.pagePath(page.slug), serializePage(page));
  }

  // Compact inventory (slug — kind — summary [aliases]) fed to the LLM so it
  // reuses existing slugs.
  inventory(pages: WikiPage[] = this.listPages()): string {
    if (pages.length === 0) return '(no pages yet)';
    return pages
      .map((p) => {
        const aliases = p.aliases.length ? ` (aliases: ${p.aliases.join(', ')})` : '';
        return `- ${p.slug} — ${p.kind} — ${p.summary}${aliases}`;
      })
      .join('\n');
  }

  linkGraph(pages: WikiPage[] = this.listPages()): LinkGraph {
    return buildLinkGraph(
      pages.map((p) => ({ slug: p.slug, aliases: p.aliases, outbound: parseWikilinks(p.body) }))
    );
  }

  // Regenerate index.md deterministically: grouped by kind, sorted by updated
  // desc, with an orphan section (no inbound links) at the bottom. No LLM.
  renderIndex(pages: WikiPage[] = this.listPages()): void {
    writeFileSync(this.indexPath, renderIndexMarkdown(pages, this.linkGraph(pages)));
  }

  git(args: string[]): { ok: boolean; out: string } {
    try {
      const out = execFileSync('git', ['-C', this.dir, ...args], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, out };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
    }
  }

  // Stage everything and commit; a no-op commit (nothing changed) returns ok:false
  // harmlessly.
  commit(message: string): void {
    this.git(['add', '-A']);
    this.git(['commit', '-q', '-m', message]);
  }

  head(): string | null {
    const r = this.git(['rev-parse', '--short', 'HEAD']);
    return r.ok ? r.out.trim() : null;
  }
}

// ---------------------------------------------------------------------------
// Frontmatter codec
// ---------------------------------------------------------------------------

export function parsePage(slug: string, raw: string): WikiPage {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`page ${slug}: missing YAML frontmatter`);
  let fm: Record<string, unknown>;
  try {
    // Bun.YAML.parse is available (Bun >= 1.2.21); avoids a YAML dependency.
    fm = (Bun.YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`page ${slug}: malformed YAML frontmatter (${err instanceof Error ? err.message : err})`);
  }
  const body = m[2]!.trim();
  return {
    slug,
    schema: typeof fm.schema === 'number' ? fm.schema : Number(fm.schema ?? PAGE_SCHEMA),
    title: str(fm.title) || slug,
    kind: (PAGE_KINDS as readonly string[]).includes(str(fm.kind)) ? (fm.kind as PageKind) : 'topic',
    summary: str(fm.summary),
    aliases: strArray(fm.aliases),
    sources: strArray(fm.sources),
    trajectories: strArray(fm.trajectories),
    fingerprint: str(fm.fingerprint),
    created: str(fm.created),
    updated: str(fm.updated),
    body,
  };
}

// Deterministic serializer (fixed key order, quoted strings) for stable git diffs.
export function serializePage(page: WikiPage): string {
  const lines: string[] = ['---'];
  for (const key of FRONTMATTER_KEYS) {
    switch (key) {
      case 'schema':
        lines.push(`schema: ${page.schema}`);
        break;
      case 'aliases':
        lines.push(`aliases: ${yamlList(page.aliases)}`);
        break;
      case 'sources':
        lines.push(`sources: ${yamlList([...page.sources].sort())}`);
        break;
      case 'trajectories':
        lines.push(`trajectories: ${yamlList([...page.trajectories].sort())}`);
        break;
      default:
        lines.push(`${key}: ${yamlScalar(String(page[key] ?? ''))}`);
    }
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${page.body.trim()}\n`;
}

function yamlScalar(s: string): string {
  return JSON.stringify(s);
}

function yamlList(items: string[]): string {
  if (items.length === 0) return '[]';
  return `[${items.map(yamlScalar).join(', ')}]`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

// ---------------------------------------------------------------------------
// index.md render
// ---------------------------------------------------------------------------

export function renderIndexMarkdown(pages: WikiPage[], graph: LinkGraph): string {
  const lines: string[] = ['# Index', ''];
  lines.push(`_${pages.length} page${pages.length === 1 ? '' : 's'} · regenerated by \`engram wiki ingest\`. Do not edit._`, '');

  const byKind = new Map<PageKind, WikiPage[]>();
  for (const p of pages) {
    const arr = byKind.get(p.kind) ?? [];
    arr.push(p);
    byKind.set(p.kind, arr);
  }

  for (const kind of PAGE_KINDS) {
    const group = byKind.get(kind);
    if (!group || group.length === 0) continue;
    group.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    lines.push(`## ${kind}`, '');
    for (const p of group) lines.push(`- [[${p.slug}]] — ${p.summary || p.title}`);
    lines.push('');
  }

  const orphans = pages
    .filter((p) => (graph.inbound.get(p.slug)?.length ?? 0) === 0)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (orphans.length > 0) {
    lines.push('## orphans', '', '_No page links to these:_', '');
    for (const p of orphans) lines.push(`- [[${p.slug}]] — ${p.summary || p.title}`);
    lines.push('');
  }

  return lines.join('\n');
}
