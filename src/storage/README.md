# storage/

Two stores: Postgres+pgvector for durable memory, local sqlite for ingest bookkeeping.

## Files

**`backend.ts`** — The seams. `VectorBackend` (initialize / insertRawEvents / upsert / search / getTrajectory / count / close) is the contract any vector store must satisfy — swap pgvector for another engine here without touching ingest or search. `EmbeddingCache` (get/put by content sha + model) is what `Embedder` consumes; `VectorBackend` extends it.

**`pgvector.ts`** — `PgVectorBackend`, the production backend. `initialize()` is idempotent (all `IF NOT EXISTS`) and safe to run on every command. Three tables:
- `raw_events` — append-only store of record. Every trajectory/document's full payload (jsonb) with `owner`, `source`, `session_id`, `content_sha256` (unique, `ON CONFLICT DO NOTHING` → naturally idempotent), `occurred_at`. Inserts only. Everything else is rebuildable from this table.
- `chunks` — embedded chunks: `embedding vector(N)` with HNSW cosine index (m=16, ef_construction=64); `content_tsv`, a **generated stored** tsvector column (stays in sync with `content` automatically, backfilled existing rows on first add, GIN-indexed) powering the keyword half of hybrid search; metadata columns (repo, branch, timestamp, file_paths, session_id, tier raw/dream); per-chunk provenance (`trajectory_id`, `chunk_index`, `chunk_count`); version stamps (`owner`, `chunker_version`, `embedding_model`) so re-indexing is a filtered batch job.
- `embedding_cache` — `(content_sha256, embedding_model) → vector`. Unconstrained vector column so models with different dims coexist.

Search is hybrid (weighted vector + keyword rank + optional time decay — math and candidate-pool strategy in `../search/README.md`), with `ScoringConfig` passed to the constructor and optional repo/branch/since/tier/exit-code/`owner` filters. `upsert`/`insertRawEvents` take a per-row `owner` (default `derek`), so multiple tenants/connectors coexist. `filters.exhaustive` forces a seq-scan (exact cosine) inside a `SET LOCAL` transaction — needed when a selective filter like `owner` would starve the HNSW candidate set. `deleteByOwner` / `deleteByOwnerPrefix` retract an owner's chunks + raw events atomically (bench cleanup, connector retraction). Postgres NOTICEs suppressed via `onnotice`. All data paths use postgres.js tagged-template parameters; `sql.unsafe` appears only for constant DDL.

**`local.ts`** — `LocalStore`, bun:sqlite at `~/.engram/engram.sqlite` (WAL). Tables: `cursor` (per-session trajectory offset), `seen_hashes` (chunk-level dedup), `ingestion_queue` (retry scaffolding), `stats` (key/value). Derived state: safe to wipe if you intend a full re-index.
