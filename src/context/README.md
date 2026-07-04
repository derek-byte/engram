# context/

The injection layer: turns the knowledge pyramid into a compact block a new Claude Code session starts with, so it already knows what you decided in this repo. Feeds `engram context` (see [`../commands/README.md`](../commands/README.md)); wired to `SessionStart` via `engram hooks print`.

- **`resolve.ts`** — `resolveFromCwd(cwd)` → `{ repo, branch? }`, read-only `git`. `repo = basename(git rev-parse --show-toplevel)` (matches the ingest convention `repoFromCwd = basename(cwd)`), falling back to `basename(cwd)` for a non-git dir. `branch = rev-parse --abbrev-ref HEAD`; detached `HEAD` or any git failure → `branch: undefined`.
- **`compose.ts`** — `buildContext(params, { backend, store })`, dependency-injected (fake `ContextStore` in tests, no DB/LLM). Three owner-scoped arms, all pure SQL:
  1. **Provenance pages** (`wikiPagesForRepo`) — wiki pages whose `source_chunk_ids` trace to dream chunks with `repo=<repo>`, ranked by matched-source count desc, then chunk timestamp desc, then slug asc. The primary relevance signal.
  2. **Mention pages** (`keywordSearchChunks` over `tier='wiki'`) — `websearch_to_tsquery` OR of sanitized repo+branch tokens; appended after provenance, deduped by slug. **Supplementary only**: suppressed entirely for an unknown repo (no provenance *and* no memories), so a bare repo name's generic tokens (`repo`, `app`) can't pull unrelated pages.
  3. **Recent memories** (`recentDreamChunks`) — dream chunks of `dream_type ∈ {decision, gotcha}`, last 30 days, newest first.
- Page display text comes from frontmatter `title`/`summary`/`updated` via a read-only `WikiStore` (the summary is the purpose-built one-liner; pg wiki-chunk timestamps are reindex times, unusable for display), with a first-sentence chunk-excerpt fallback when the file is missing.
- **Budget** (`estTokens = ⌈chars/4⌉`, the repo's `CHARS_PER_TOKEN`): reserve header + section headers + footer, fill pages up to 40% of the remainder, then memories, then leftover back to pages. Hard caps 6 pages / 10 memories. Items are added or dropped **whole** — never mid-sentence (dream items are 1–3 self-contained sentences; page lines are one-liners). Footer counts reflect what actually rendered.
- **Silent-empty** is structural, not a score threshold: only provenance matches, verbatim keyword mentions of a *known* repo, and repo-scoped recent dream items produce candidates. Zero candidates → `markdown: ''`, and the CLI prints nothing.

**Config gate:** `contextInjection` in `~/.engram/config.json` (`{ enabled: true, budget: 1500 }`, see [`../config/README.md`](../config/README.md)) — `enabled: false` makes the command print nothing (the hook stays installed); `budget` is the default token budget, overridden per-run by `--budget`.

**Branch is never a hard filter** — dream chunks store `branch=''` and wiki chunks store `repo=''`/`branch=''` (verified in `dream/synthesize.ts`, `wiki/ingest.ts`), so branch only feeds the keyword query tokens and the header.

**Known limits** (precision > recall, deliberately, so silent-empty is trustworthy): ingest stamps `repo = basename(session cwd)`, so a session started in a subdirectory records under the subdir's basename and won't match the git-toplevel basename this command resolves; two projects sharing a folder name also collide. A cross-cutting `topic` page with neither provenance nor a verbatim name mention is omitted — the footer points at `engram search` to dig deeper.
