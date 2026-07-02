# search/

Query orchestration. Deliberately thin today: `runSearch(query, filters, deps)` embeds the query via `Embedder.embedOne` and delegates to `VectorBackend.search` (cosine similarity + metadata filters, incl. `owner` and an `exhaustive` exact-search escape hatch).

This is the layer where the retrieval ladder lands as it's built out — hybrid vector+keyword scoring, LLM reranking, and/or delegation to an external engine (MemPalace) — without touching ingest, storage, or the CLI.

Refs: raw → hybrid → rerank ladder — [MemPalace](https://github.com/MemPalace/mempalace), [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus).
