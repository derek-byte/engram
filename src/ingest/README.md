# ingest

Turns Claude Code `.jsonl` session logs into embedded chunks in pgvector.

`parser → chunker → embed → pipeline` (`watcher` drives it live; `backfill` runs it over history).

## Embedding provider layer (`embed.ts`)

`Embedder` is provider-agnostic: it owns the read-through cache (keyed by
`content_sha256` + model), the oversized-input guard, and hit/miss stats. It
delegates the actual vector math to an `EmbeddingProvider`:

- `OpenAIProvider` — `text-embedding-3-small`, 1536-dim. Enforces
  `MAX_CHARS_PER_INPUT` (24k) via `maxInputChars`.
- `FastembedProvider` — local ONNX `all-MiniLM-L6-v2`, 384-dim, via the
  `fastembed` npm package. Model files download on first use to
  `~/.engram/models`. No char cap — MiniLM's 512-token window truncates
  internally, so `maxInputChars` is undefined.

`buildProvider(config)` picks the provider from `config.embeddingProvider`.

### Fallback latch

When the provider is `openai` and a call fails after retries (or no API key is
configured), `FallbackProvider` latches to the local provider for the rest of
the process — one warning, no per-batch re-probing (the Odysseus "HTTP-down
latch"). `Embedder` always caches and stamps chunks with the model that
**actually** embedded (`EmbedResult.model`, written to `chunks.embedding_model`),
never the configured one. If a latch happens mid-batch and that batch had
cache hits from the old model, the whole batch is re-embedded under the new
model so no single batch mixes dimensions.

### Mixed-index caveat

Vectors from different models must never be compared, and pgvector's `vector(N)`
column is a fixed dimension. A mid-ingest latch (openai 1536 → local 384) stamps
the new chunks with the local model; those rows can only be stored if the column
dimension matches (i.e. run fully local, or the insert fails loudly on the dim
mismatch). Search embeds the query with the **configured** provider and falls
back the same way — it does not try to match the majority model of the index. A
re-embed batch job reconciles a mixed index by re-embedding all chunks under one
model. Until then, keep a run single-model.
