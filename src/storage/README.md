# storage/

Two stores: Postgres+pgvector for durable memory, local sqlite for ingest bookkeeping.

## Files

**`backend.ts`** — The seams. `VectorBackend` (initialize / insertRawEvents / upsert / search / count / close) is the contract any vector store must satisfy — swap pgvector for another engine here without touching ingest or search. `EmbeddingCache` (get/put by content sha + model) is what `Embedder` consumes; `VectorBackend` extends it.

**`pgvector.ts`** — `PgVectorBackend`, the production backend. Three tables, all DDL idempotent:
- `raw_events` — append-only store of record. Every trajectory's full payload (jsonb) with `owner`, `source`, `session_id`, `content_sha256` (unique, `ON CONFLICT DO NOTHING` → naturally idempotent), `occurred_at`. Inserts only. Everything else in the system is rebuildable from this table.
- `chunks` — embedded chunks with HNSW cosine index (m=16, ef_construction=64), metadata columns (repo, branch, timestamp, file_paths, session_id, tier raw/dream), per-chunk provenance (`trajectory_id`, `chunk_index`, `chunk_count`), and version stamps (`owner`, `chunker_version`, `embedding_model`) so re-indexing is a filtered batch job.
- `embedding_cache` — `(content_sha256, embedding_model) → vector`. Unconstrained vector column so models with different dims coexist.

Search is cosine similarity (`1 - (embedding <=> query)`) with optional repo/branch/since/tier/exit-code/**owner** filters. `upsert`/`insertRawEvents` take a per-row `owner` (default `derek`), so multiple tenants/connectors coexist. `filters.exhaustive` forces a seq-scan (exact cosine) inside a `SET LOCAL` transaction — needed when a selective filter like `owner` would starve the HNSW candidate set; production searches leave it off. `deleteByOwner(owner)` / `deleteByOwnerPrefix(prefix)` retract an owner's chunks + raw events (used for bench cleanup and connector retraction). Postgres NOTICEs are suppressed via `onnotice`. All data paths use postgres.js tagged-template parameters; `sql.unsafe` appears only for constant DDL.

**`local.ts`** — `LocalStore`, bun:sqlite at `~/.engram/engram.sqlite` (WAL). Tables: `cursor` (per-session trajectory offset — where ingestion left off), `seen_hashes` (chunk-level dedup), `ingestion_queue` (retry scaffolding), `stats` (key/value, e.g. `last_ingest_at`). This is derived state: safe to wipe if you intend a full re-index.
