# search/

Query orchestration. Deliberately thin today: `runSearch(query, filters, deps)` embeds the query via `Embedder.embedOne` and delegates to `VectorBackend.search` (cosine similarity + metadata filters).

This is the layer where the retrieval ladder lands as it's built out — hybrid vector+keyword scoring, LLM reranking, and/or delegation to an external engine (MemPalace) — without touching ingest, storage, or the CLI.
