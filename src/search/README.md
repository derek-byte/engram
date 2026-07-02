# search

Turns a query string into ranked chunks.

`runSearch(query, filters, { backend, embedder })` embeds the query once and
hands both the vector and the raw text to `backend.search`.

## Hybrid scoring

`PgVectorBackend.search` blends semantic and lexical signals:

```
combined = vectorWeight * cosine_similarity + keywordWeight * keyword_rank
```

- `cosine_similarity` = `1 - (embedding <=> query)`, in [0,1].
- `keyword_rank` = `ts_rank_cd(content_tsv, websearch_to_tsquery('english', query), 32)`.
  Flag `32` normalizes the raw rank to `rank/(rank+1)`, giving [0,1) without any
  ad-hoc max-scaling. `websearch_to_tsquery` is parameterized, so arbitrary user
  text is safe.

Weights live in `EngramConfig` (`vectorWeight`/`keywordWeight`, defaults
`0.7`/`0.3` — the pattern validated by MemPalace and Odysseus). Setting
`vectorWeight=1, keywordWeight=0` reproduces pure-vector ranking exactly.

### Candidate pool (efficiency)

We do **not** full-scan. The query first takes the top `100` chunks by vector
distance against the HNSW index, then scores keyword rank on just those
candidates, re-ranks by `combined`, and returns `limit`. A keyword-only match
that falls outside the vector top-100 is an accepted miss at the current corpus
size (a few thousand chunks); revisit if recall on rare identifiers degrades.

### Time decay (optional, off by default)

When `timeDecayHalfLifeDays > 0`, `combined` is multiplied by
`exp(-age_days / halfLifeDays)` (chunks with no timestamp are left untouched).
It is off by default on purpose: decay biases against old-decision recall, which
is exactly what engram exists to surface. It has to earn its place on the
benchmark before becoming a default.

## Result shape

`SearchResult` exposes the component scores so callers can inspect ranking:
`similarity`, `keywordRank`, `combined`. `engram search --json` includes all
three.
