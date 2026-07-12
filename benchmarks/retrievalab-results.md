# Retrieval A/B: embedding provider × contextual prefixes (2026-07-13)

One experiment, two questions that had been sitting in the backlog:

1. **Is the local embedding model (MiniLM) good enough, or should we pay for OpenAI embeddings?**
2. **Do LLM-generated contextual chunk prefixes (the [Anthropic contextual-embeddings technique](https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide)) improve retrieval?**

The two are coupled — a prefix eats into MiniLM's ~256-token attention window — so they were tested together as a four-arm A/B rather than sequentially.

## What we did

`benchmarks/retrievalab.ts` built four complete search indexes of the real corpus (632 session files → 1,993 trajectories → 13,084 v3 chunks) and asked each the same 300 self-retrieval questions: given the first 200 characters of a user turn, find that turn's chunks. Scored hit@1/3/5 and MRR@10, matched on `trajectoryId`, seed 42.

| arm | embedder | chunk text |
|---|---|---|
| A | local MiniLM `all-MiniLM-L6-v2` (384d) | v3 chunks as-is (shipping config) |
| B | MiniLM | one-sentence LLM context + chunk |
| C | OpenAI `text-embedding-3-small` (1536d) | v3 chunks as-is |
| D | 3-small | context + chunk |

Prefixes were generated once (shared by B and D) by gpt-4o-mini, which saw each chunk's full trajectory (head/tail-capped) and wrote a single situating sentence — e.g. *"…details the creation of a commit and PR for the 'Follow-up badge: cold outreach only' feature…"*. Every arm queried through the production search path (two-arm hybrid SQL, exhaustive mode) in two throwaway bench databases; the live database was never written.

## Results

| slice | arm | n | hit@1 | hit@3 | hit@5 | MRR@10 |
|---|---|---|---|---|---|---|
| overall | A (MiniLM/raw) | 300 | 56.0% | 69.3% | 73.0% | 0.640 |
| overall | B (MiniLM/prefix) | 300 | 51.3% | 67.0% | 70.7% | 0.601 |
| overall | **C (3-small/raw)** | 300 | **84.0%** | **94.7%** | **96.7%** | **0.896** |
| overall | D (3-small/prefix) | 300 | 77.0% | 91.0% | 94.3% | 0.849 |
| tool-heavy | A | 130 | 56.9% | 71.5% | 76.2% | 0.659 |
| tool-heavy | C | 130 | **89.2%** | 96.9% | 98.5% | 0.936 |
| pure prose | A | 170 | 55.3% | 67.6% | 70.6% | 0.625 |
| pure prose | C | 170 | **80.0%** | 92.9% | 95.3% | 0.866 |

## Verdict

**1. Switch the embedder: 3-small beats MiniLM by +28.0pt hit@1** (84.0% vs 56.0%), consistent in both slices, far beyond the ~2.5pt noise floor at n=300. Notably, LongMemEval had shown only a 3.4pt gap — chat-memory benchmarks do not represent coding-session data. Real-corpus measurement is the only one that counts.

**2. Drop contextual prefixes: they measured negative on both embedders** — B−A = −4.7pt, D−C = −7.0pt. Sampled prefixes were specific and well-formed, and 3-small's 8k window rules out truncation, so the loss is real dilution of the chunk's own signal on lookup-style queries. Only revival condition: re-test on *paraphrased* queries after the provider switch (self-retrieval favors lexical overlap and understates the prefix's paraphrase upside — but any gain must first repay the −7pt).

## Cost & caveats

- Total spend **$3.44**: $3.26 prefix generation (18.7M in / 321k out tokens, gpt-4o-mini — throttled hard by the org's 10k requests/day cap, which stretched the run to ~13h wall), $0.16 embeddings + smoke.
- 6.4% of B/D chunks fell back to raw text under the rate-limit; dilutes prefix deltas ~6%, changes no conclusion.
- All arms ingested without image captions (uniform treatment — deltas valid; absolute numbers not comparable to the live index).
- Machinery kept: `src/ingest/contextPrefix.ts` (the prefix module), `benchmarks/prefixcache.ts` (crash-safe JSONL cache, 11,297 prefixes banked — a paraphrase re-test costs ~$0).

## Reproduce

```
bun benchmarks/retrievalab.ts --limit 25 --max-queries 40   # ~$0.10 smoke
bun benchmarks/retrievalab.ts --max-queries 300             # full run
```
