# search/

Turns a query string into ranked chunks. `runSearch(query, filters, { backend, embedder })` embeds the query once (query embeddings hit the pg cache) and hands both the vector and the raw text to `backend.search`. Filters include `owner` and an `exhaustive` exact-search escape hatch.

## Hybrid scoring

`PgVectorBackend.search` blends semantic and lexical signals:

```
combined = vectorWeight * cosine_similarity + keywordWeight * keyword_rank
```

- `cosine_similarity` = `1 - (embedding <=> query)`, in [-1,1] (in practice positive).
- `keyword_rank` = `ts_rank_cd(content_tsv, websearch_to_tsquery('english', query), 32)`. Flag `32` normalizes to `rank/(rank+1)` → [0,1); the tsquery is parameterized, so arbitrary user text is safe.

Weights live in `EngramConfig` (`vectorWeight`/`keywordWeight`, defaults `0.7`/`0.3`). `vectorWeight=1, keywordWeight=0` reproduces pure-vector ranking exactly.

**Candidate pool:** no full scan — vector top-100 via HNSW, keyword-score those candidates, re-rank, return `limit`. A keyword-only match outside the vector top-100 is an accepted miss at a few thousand chunks; revisit if rare-identifier recall degrades. `hnsw.ef_search` (default 40) is raised to the pool size via `SET LOCAL` so the index scan can't silently shrink the pool.

**Time decay (off by default):** when `timeDecayHalfLifeDays > 0`, `combined` is multiplied by `exp(-age_days / halfLife)`. Off on purpose — decay biases against old-decision recall, which is what engram exists to surface; it must earn its place on the benchmark.

## Result shape

`SearchResult` exposes component scores: `similarity`, `keywordRank`, `combined`. `engram search --json` includes all three.

Next rung: LLM reranking (top-K → top-5) slots in here without touching ingest, storage, or the CLI.

Refs: raw → hybrid → rerank ladder — [MemPalace](https://github.com/MemPalace/mempalace), [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus).
