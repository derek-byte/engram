# storage

`VectorBackend` is the storage interface; `PgVectorBackend` (Postgres + pgvector)
is the implementation. `LocalStore` (SQLite) is unrelated bookkeeping — ingest
cursors and seen-hash dedup, not vectors.

`initialize()` is idempotent (all `IF NOT EXISTS`) and safe to run on every
command; it is where the schema lives.

## chunks

Vector column: `embedding vector(N)` with an HNSW cosine index
(`chunks_embedding_idx`).

Full-text column: `content_tsv` is a **generated stored** column
(`GENERATED ALWAYS AS to_tsvector('english', content) STORED`) added idempotently
via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, indexed by GIN
(`chunks_content_tsv_idx`). Being generated, it stays in sync with `content`
automatically and backfills existing rows when the column is first added — no
ingest changes required.

Hybrid retrieval (weighted vector + keyword rank, optional time decay) lives in
`PgVectorBackend.search`; scoring weights come from `ScoringConfig` passed to the
constructor. See `../search/README.md` for the scoring math and candidate-pool
strategy.
