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

One **unit** = one `(session_id, repo)`'s dream chunks. Units are compiled **OLDEST-first** (sorted ASC by newest source timestamp in `ingestWiki`, NOT in the shared SQL) so the latest knowledge merges LAST and a late unit can't clobber it via a full-page rewrite. Consequence: `--limit N` drains the OLDEST N pending units (`deferred` = newest, next run). Per pending unit (serial, per-unit try/catch → `failed++`):
1. **Candidate discovery** — embed each dream item, search `tier='wiki', owner, exhaustive` top-5 (exhaustive because the wiki tier is small + owner-filtered, so HNSW starves), plus verbatim title/alias matches; cap at 8 pages / `wikiMaxInputChars`.
2. **One LLM call** — system = stable `WIKI_SYSTEM_PROMPT` (Odysseus-conservative; never invent; reuse inventory slugs; every page links its entities; RECENCY: replace a superseded claim + keep a one-line `Originally X (date); revised to Y (date)` evolution record, never co-equal contradictions, never regress a newer-dated page claim; CROSS-PROJECT: attribute claims to the entity they're about, give other repos their own linked page). The per-unit **user header carries the session date** and candidate blocks carry each page's `updated` date so the model reasons about recency (system prompt stays byte-stable → OpenAI prompt caching intact). Returns full create/update page ops. `parsePageOps` throws on malformed JSON (unit fails → retries); drops ops with bad slug/kind/action.
3. **Auto-link (deterministic post-pass)** — before writing, `autolinkBody` scans each op body for verbatim mentions of other pages' titles/aliases (word-boundary, case-insensitive, outside code fences/inline spans/existing links) and wraps the FIRST unlinked mention per page in `[[slug|text]]`. Targets = inventory ∪ this batch's ops (siblings interlink). Guarantees edges regardless of LLM compliance; only adds chars so it runs BEFORE the shrink guard. `pagesAutolinked` is on the result.
4. **Write pages** — merge frontmatter monotonically (`sources`/`trajectories` only grow), recompute page fingerprint, bump `updated` (all three paths share one `writeOp` helper). **Anti-clobber (retry-then-addendum)**: `violatesShrinkGuard(old,new)` (a rewrite < 40% of an old body > 500 chars) no longer drops the unit's contribution. Pass 1 collects the tripping ops; ONE retry LLM call per unit re-asks the model to MERGE them (correction block restates each slug's char drop + re-supplies the FULL existing body, appended AFTER the byte-stable prefix so prompt caching holds). A retry op that clears the guard is written (`pagesRetried`); if it still shrinks (or the retry call failed / returned no op), the would-be-lost NEW body is appended as a dated `## Addendum (YYYY-MM-DD)` to the existing page (`pagesAddendum`) — appending only grows the body so it never trips the guard, and knowledge is never dropped. `pagesSkippedGuard` keeps its JSON name but now means "guard trips"; invariant (retry call didn't throw): `pagesSkippedGuard === pagesRetried + pagesAddendum`, and retry/addendum writes also bump `pagesUpdated`. The guard itself stays the hard floor; ingest never deletes pages; the wiki dir is auto-`git init`-ed and every run commits (one `git revert` away).
5. **Embed + sync** each touched page (`syncPageToIndex`: content-addressed upsert, delete old−new).
6. **`upsertWikiUnit` LAST** — a mid-unit failure leaves the ledger unrecorded so the unit retries; page writes + pg sync are idempotent-by-content.

## Hub split (`splitPage`, `engram wiki split <slug>`)

One LLM call (`WIKI_SPLIT_SYSTEM_PROMPT`, own stable prefix) takes an oversized page and returns a rewritten hub (`action:"update"`, short `[[link]]` index with a 2-3 sentence overview per section) plus child `create` ops carving the content into focused pages. The hub legitimately shrinks, so this path **deliberately does NOT call the shrink guard** for the hub op (`shrinkGuardBypassed: true`) — the guard's constants/ingest behavior are globally unchanged. Validation is strict: exactly one hub-slug update + ≥1 child create or the whole split fails with nothing written; child ops targeting an existing OTHER slug are dropped with a warning (never silently overwrite). Provenance: each child = the subset of hub sources it supports, else the FULL hub set; children inherit the hub's full `trajectories`; the hub keeps its full sources (fingerprint preserved). All bodies are auto-linked, then flow through the exact `writePage → syncPageToIndex → renderIndex → commit` path (syncPageToIndex's old−new reconciliation collapses the hub's stale chunks for free). **`wiki_units` is untouched** — its `pages[]` is historical attribution, not an ingest input; children are rediscovered as candidates via embedding search. Not atomic across pages (a crash leaves partial children + old hub uncommitted; re-run or `git checkout` recovers).

After all units: regenerate `index.md` deterministically (grouped by kind, sorted by `updated`, orphan section at bottom — no LLM, always fresh) and commit. `reindexWiki` reconciles the whole dir and drops pg wiki chunks whose `trajectory_id` matches no file (page deletion/rename).

## Files

- **`store.ts`** — `WikiStore` (filesystem pages, frontmatter codec, `SCHEMA.md` bootstrap, `index.md` render, git helpers, safety-validated `wikiDir`), `pageFingerprint`.
- **`links.ts`** — `slugify`, `parseWikilinks` (strips fenced code first), `buildLinkGraph` (alias-resolving inbound/outbound + dangling), `normalizedEditDistance`, `autolinkBody` (offset-preserving masked ranges, longest-needle-first with claimed-range overlap resolution, explicit `[A-Za-z0-9_]` boundaries, ambiguous aliases link nothing).
- **`prompt.ts`** — `WIKI_SYSTEM_PROMPT` (stable prefix → OpenAI prompt caching) + user builders.
- **`llm.ts`** — `WikiIngestLLM` seam + `OpenAIWikiLLM` (chat.completions, json_object, temp 0) + strict `parsePageOps`.
- **`ingest.ts`** — `ingestWiki`, `syncPageToIndex`, `reindexWiki`, `pageToChunkTexts`, `violatesShrinkGuard`, `buildLinkTargets`.
- **`split.ts`** — `splitPage` (hub split; reuses ingest's write path + `autolinkBody`).
- **`lint.ts`** — `lintWiki`: deterministic orphan / dangling-link / link-less / oversized (> 8000 chars → warn, names `wiki split`) / spelling-drift / broken-provenance / fingerprint-mismatch / stub / malformed checks + optional `--llm` contradiction pass. Findings are information, never auto-fixed.

## CLI

```bash
engram wiki ingest --repo engram --dry-run                 # compile plan + token estimate, no cost
engram wiki ingest --repo engram --limit 8                 # compile OLDEST 8 changed/new units (order-sensitive merge)
engram wiki ingest --owner test:d --wiki-owner test:wiki   # read one owner, write under another (test data)
engram wiki split engram --json                            # split an oversized hub → link-index + child pages
engram wiki lint            # orphans, dangling links, drift, oversized, broken provenance …
engram wiki status --json   # page count by kind, links/orphans, last ingest, pending units, git head
engram wiki reindex         # rebuild the pg tier='wiki' index from the files
```

`ENGRAM_WIKI_DIR` overrides `wikiDir` (mandatory for dev/test — never write the real `~/.engram/wiki`); `ENGRAM_WIKI_MODEL` overrides `wikiModel` (`gpt-4o-mini`). A shared advisory lock (`~/.engram/synthesis.lock`) serializes `dream`, `wiki ingest`, and the nightly `synthesis-run`.
