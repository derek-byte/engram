# wiki/

The wiki layer (L2): compiles dream chunks (L1) into digestible, git-versioned
markdown knowledge pages — "compile, don't retrieve" (spec `docs/wave-5-wiki-spec.md`).
Mirrors the dream layer's proven shape: pure core function with injected deps, a
pg ledger with a fingerprint short-circuit, ledger-written-LAST failure semantics,
`--owner`/`--wiki-owner` separation for test data, and a `--dry-run --json` surface.

## Model

- **Page** = one entity/topic at `<wikiDir>/pages/<slug>.md` (flat dir, kebab-case slug `^[a-z0-9-]{1,64}$`). Category is frontmatter `kind` (project|decision|gotcha|tool|person|topic), not a subfolder — Obsidian resolves `[[wikilinks]]` by name.
- **Frontmatter** (YAML, `schema: 1`): title, kind, summary, aliases, `sources` (dream-chunk ids — provenance, append-only), `trajectories` (`dream:<unit fp>` for the raw drill-down overlay), `fingerprint` (sha256 of sorted sources), created/updated. Read via `Bun.YAML.parse`, written by a deterministic serializer (fixed key order, quoted strings) for stable git diffs.
- **Files are the source of truth**; pg `tier='wiki'` chunks are a derived, rebuildable index. Page body → 1 chunk (split on `##` only if over the chunk budget), `id = chunkHash('wiki:'+slug, i, text)`, `trajectory_id = 'wiki:'+slug` (so the existing `getTrajectory()`/UI overlay renders a full page for free), `dream_type` reused for the page kind, `sourceChunkIds` = dream ids.
- **Ingest ledger** = `wiki_units` (PK owner/session_id/repo, `fingerprint` = sha256 of the unit's sorted dream-chunk ids). A matching fingerprint short-circuits the unit → re-ingest is 100% skip, zero LLM calls.

## Compile loop (`ingestWiki`, rule V — trace implications)

One **unit** = one `(session_id, repo)`'s dream chunks. Per pending unit (serial, per-unit try/catch → `failed++`):
1. **Candidate discovery** — embed each dream item, search `tier='wiki', owner, exhaustive` top-5 (exhaustive because the wiki tier is small + owner-filtered, so HNSW starves), plus verbatim title/alias matches; cap at 8 pages / `wikiMaxInputChars`.
2. **One LLM call** — system = stable `WIKI_SYSTEM_PROMPT` (Odysseus-conservative; never invent; reuse inventory slugs; every page links its entities), user = items + candidate pages' full text + inventory. Returns full create/update page ops. `parsePageOps` throws on malformed JSON (unit fails → retries); drops ops with bad slug/kind/action.
3. **Write pages** — merge frontmatter monotonically (`sources`/`trajectories` only grow), recompute page fingerprint, bump `updated`. **Anti-clobber**: shrink guard rejects a rewrite < 40% of an old body > 500 chars; ingest never deletes pages; the wiki dir is auto-`git init`-ed and every run commits (one `git revert` away).
4. **Embed + sync** each touched page (`syncPageToIndex`: content-addressed upsert, delete old−new).
5. **`upsertWikiUnit` LAST** — a mid-unit failure leaves the ledger unrecorded so the unit retries; page writes + pg sync are idempotent-by-content.

After all units: regenerate `index.md` deterministically (grouped by kind, sorted by `updated`, orphan section at bottom — no LLM, always fresh) and commit. `reindexWiki` reconciles the whole dir and drops pg wiki chunks whose `trajectory_id` matches no file (page deletion/rename).

## Files

- **`store.ts`** — `WikiStore` (filesystem pages, frontmatter codec, `SCHEMA.md` bootstrap, `index.md` render, git helpers, safety-validated `wikiDir`), `pageFingerprint`.
- **`links.ts`** — `slugify`, `parseWikilinks` (strips fenced code first), `buildLinkGraph` (alias-resolving inbound/outbound + dangling), `normalizedEditDistance`.
- **`prompt.ts`** — `WIKI_SYSTEM_PROMPT` (stable prefix → OpenAI prompt caching) + user builders.
- **`llm.ts`** — `WikiIngestLLM` seam + `OpenAIWikiLLM` (chat.completions, json_object, temp 0) + strict `parsePageOps`.
- **`ingest.ts`** — `ingestWiki`, `syncPageToIndex`, `reindexWiki`, `pageToChunkTexts`.
- **`lint.ts`** — `lintWiki`: deterministic orphan / dangling-link / link-less / spelling-drift / broken-provenance / fingerprint-mismatch / stub / malformed checks + optional `--llm` contradiction pass. Findings are information, never auto-fixed.

## CLI

```bash
engram wiki ingest --repo engram --dry-run                 # compile plan + token estimate, no cost
engram wiki ingest --repo engram --limit 8                 # compile newest 8 changed/new units
engram wiki ingest --owner test:d --wiki-owner test:wiki   # read one owner, write under another (test data)
engram wiki lint            # orphans, dangling links, drift, broken provenance …
engram wiki status --json   # page count by kind, links/orphans, last ingest, pending units, git head
engram wiki reindex         # rebuild the pg tier='wiki' index from the files
```

`ENGRAM_WIKI_DIR` overrides `wikiDir` (mandatory for dev/test — never write the real `~/.engram/wiki`); `ENGRAM_WIKI_MODEL` overrides `wikiModel` (`gpt-4o-mini`). A shared advisory lock (`~/.engram/synthesis.lock`) serializes `dream`, `wiki ingest`, and the nightly `synthesis-run`.
