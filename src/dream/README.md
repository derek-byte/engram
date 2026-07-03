# dream/

The dream layer: an incrementally-maintained synthesis tier over raw chunks (LLM-Wiki pattern with an Odysseus fingerprint short-circuit). `engram dream` groups raw chunks into synthesis units, extracts durable memory with a conservative LLM prompt, and writes the results as `tier='dream'` chunks that are immediately searchable.

## Model

- **Synthesis unit** = one `(session_id, repo)` — ~9× fewer LLM calls than per-trajectory, captures cross-turn arcs, fits gpt-4o-mini's context at p90.
- **Fingerprint** = `sha256` of the unit's sorted source chunk ids. Persisted in the `dream_units` table (PK `owner, session_id, repo`). A re-run whose fingerprint matches is skipped for free — the command is cheap and idempotent.
- **Extraction** is Odysseus-conservative: pull ONLY decisions / fixes / gotchas / stated preferences actually present. Empty output is valid — it records the fingerprint and writes no chunk (`emptyUnits`).
- **One dream chunk per extracted item** (`dream_type` set), content = the item text verbatim, embedded through the normal `Embedder` + pg cache so it shares the 384-dim space with raw chunks.
- **Provenance is dual**: `chunks.source_chunk_ids TEXT[]` on each dream chunk (traceable straight from a search hit) plus a synthetic `trajectory_id = 'dream:'+fingerprint` (groups a unit's dream chunks, works with `getTrajectory`). Output also lands in `raw_events` (`source='dream'`) to preserve the store-of-record invariant, so `deleteByOwner*` retraction is complete.

## Files

- **`prompt.ts`** — `SYSTEM_PROMPT` (conservative extraction contract, strict JSON `{"items":[{type,text}]}`), `buildUnitHeader`, `buildTranscript` (join with `\n---\n`, head-truncate at `dreamMaxInputChars` with a `[transcript truncated]` marker).
- **`llm.ts`** — `DreamLLM` seam and `OpenAIDreamLLM` (chat.completions, `response_format: json_object`, temp 0, local exponential-backoff retry). `parseItems` throws on malformed JSON (unit fails → retried next run) and drops items with an unknown `type`.
- **`synthesize.ts`** — `synthesizeDreams(params, deps)`. Lists units, skips unchanged fingerprints, applies `--limit` (newest-activity first; unchanged units skip *before* the limit so re-runs stay cheap), then per unit: extract → embed → `insertRawEvents` → `upsert` new chunks → `deleteDreamChunks` (stale = old minus new, scoped `tier='dream' AND owner=`) → `upsertDreamUnit` **last** (so a mid-unit failure leaves the fingerprint unrecorded and the unit retries). `--dry-run` returns the unit plan + token estimate with zero LLM calls and zero writes.

## Write ordering & failure

The fingerprint is recorded last. Any mid-unit failure (LLM/parse error) increments `failed`, logs, and continues; the unit self-heals next run. Orphaned chunks are idempotent by id and get replaced on retry.

## CLI

```bash
engram dream --repo engram --dry-run                    # unit plan + token estimate, no cost
engram dream --repo engram --limit 3                    # synthesize newest 3 changed/new units
engram dream --owner derek --dream-owner test:dream ... # read from one owner, write under another
```

`--owner` (source, default `derek`) and `--dream-owner` (default = source) are separate so synthesis can read one owner's raw chunks and write dreams under another — required by the test-data rule (`--dream-owner test:dream`, cleaned via `deleteByOwnerPrefix('test:')`). Model is `config.dreamModel` (`gpt-4o-mini`), overridable via `ENGRAM_DREAM_MODEL`.
