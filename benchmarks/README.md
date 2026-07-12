# benchmarks

Manual eval harnesses — never CI. All need a live Postgres; two spend OpenAI money. Each was built to answer one question with a number before shipping a decision.

## Files

- **`longmemeval.ts`** — is engram's retrieval competitive? Scores the substrate on [LongMemEval](https://github.com/xiaowu0162/LongMemEval) under the same raw-mode protocol MemPalace publishes (one doc per session, user turns only, fresh index per question). Produced the README headline: R@5 0.982, NDCG@10 0.945 vs MemPalace 0.966 / 0.889. Rerun after retrieval changes (weights, rerank, embedding provider).

  ```bash
  bun benchmarks/longmemeval.ts --dataset benchmarks/longmemeval_s_cleaned.json [--limit N] [--path production] [--rerank] [--cleanup]
  ```

  Dataset is not committed (gitignored) — download it separately. Embeddings go through the pg cache, so repeat runs are ~free.

- **`chunkerab.ts`** — is a new chunker better than the live index on the *real* tool-heavy corpus? (LongMemEval sessions have no tool calls.) Self-retrieval A/B: builds a bench index with the current pipeline under owner `bench:*`, scores both arms with the same local embedder, cleans up after itself. Free, deterministic. Justified the Wave 14 chunker-v2 activation; rerun for any future chunker iteration.

  ```bash
  bun benchmarks/chunkerab.ts [--max-queries 300] [--skip-ingest] [--no-cleanup] [--out chunkerab-report.md]
  ```

- **`retrievalab.ts`** — does an LLM contextual prefix ([Anthropic's Contextual Retrieval](https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide)) and/or an OpenAI embedder beat local MiniLM on the *real* corpus? Four-arm self-retrieval A/B: A = MiniLM raw, B = MiniLM + prefix, C = OpenAI 3-small raw, D = OpenAI + prefix. Each arm ingests into one of two dedicated bench databases (`engram_bench_minilm` 384d, `engram_bench_openai` 1536d) so the exact shipping hybrid-search SQL runs verbatim; the live `derek` index is never written. A $6 budget guard aborts prefix generation before any spend it can't afford; `--force` overrides. Cleanup drops both bench DBs and asserts derek's row/tombstone counts are unchanged.

  ```bash
  # Free local smoke (no OpenAI): parse → bench DB → MiniLM ingest → score → cleanup.
  bun benchmarks/retrievalab.ts --limit 10 --max-queries 15 --arms A
  # Full run (spends OpenAI on prefixes + 3-small embeddings):
  bun benchmarks/retrievalab.ts [--arms A,B,C,D] [--max-queries 300] [--skip-ingest] [--no-cleanup] [--force] [--out retrievalab-report.md]
  ```

  Prefixes are cached to `benchmarks/.cache/prefix-cache.jsonl` (gitignored), so the ~12k-call generation pass happens once and `--skip-ingest` re-scoring is free.

- **`askeval.ts`** — does `engram ask` cite faithfully? LLM judge scores every cited claim (supported / partial / unsupported) over the curated questions. Thin CLI wrapper around `src/eval/askeval.ts` — the same core the `engram askeval-run` command drives. Costs one ask call + one judge call per question.

  ```bash
  bun benchmarks/askeval.ts [--questions <path>] [--from-demand <days>] [--limit N] [--json]
  ```

- **`askeval_questions.jsonl`** — the 20 curated ask-eval questions. Load-bearing: also the default question set for `engram askeval-run`.

## Results

Outputs are regenerated every run and gitignored, not committed:

- `results_*.jsonl` — per-question longmemeval scores (`results_engram_raw.jsonl` by default).
- `chunkerab-report.md` — the chunker A/B report (written to cwd).

Numbers worth keeping go in the root README or a wave doc, with the command that produced them.
