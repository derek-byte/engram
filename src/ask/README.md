# ask/

Turns a question into ONE synthesized, citation-backed answer. Retrieval is reused wholesale from [search](../search/README.md); ask adds a single grounded LLM call on top.

```
runSearch (hybrid, top-k, NO reranker) ──▶ number candidates [1]..[k] ──one chat call──▶ prose answer with [n] markers
                                                                                            │
                                                             extractCitedIndices ──▶ sources[] (all k, `cited` flag)
```

## No silent degradation (the ask invariant)

Opposite of rerank's null-fallback: ask MUST NOT answer without an answer. Every failure — missing key, timeout, API error, empty/refused completion — surfaces as `AskError`, which the CLI maps to stderr + exit 1 and MCP maps to `isError: true`, both pointing at `engram search`. A missing `OPENAI_API_KEY` is caught in `commands/ask.ts` **before** any DB/embedding work (fail fast, zero cost); the MCP server builds `askLLM` only when a key exists and the tool self-reports unavailability otherwise (a server must never exit).

## Prompt (dream-prompt lineage)

`ASK_SYSTEM_PROMPT` is conservative like the [dream](../dream/README.md) extractor: answer ONLY from the numbered material, no outside knowledge, cite EVERY claim with `[n]`, and say plainly (citing nothing) when the material doesn't cover the question. **Plain-text output, no `response_format: json_object`** — the answer *is* the prose, so there is no malformed-JSON failure mode (unlike rerank/dream where structure is required). Empty content throws `AskError`.

## Pieces

- `prompt.ts` — `buildAskUser` numbers candidates **1-based** (the same numbers render in the user-facing sources list), each with a tier/slug-or-repo/date header + body capped at `CANDIDATE_CHARS = 2000` (larger than rerank's 600 — the answerer needs substance; wiki markdown bodies are the payload). Bodies are head-truncated with a `[truncated]` marker, newlines preserved. `extractCitedIndices` regexes `[n]` markers, keeping integers in `[1, k]`, deduped.
- `index.ts` — `OpenAIAskLLM.answer` = one `chat.completions.create` with `modelParams(wikiModel)` (reasoning models get `max_completion_tokens`, no temperature), 60s timeout + `maxRetries: 1` (interactive; not synthesis's 120s/6-attempt batch loop). `runAsk` retrieves, short-circuits `answer: null` on zero candidates (no LLM call, zero cost), else builds `AskSource[]` for **all k** in prompt order so every `[n]` resolves. `formatSourceLine` is the one line format shared by the CLI and MCP.
- `askOutcome(result)` — the **canonical** map from an `AskResult` to its demand-log outcome, used by every ask surface (CLI, MCP; the UI mirrors it inline for now with a TODO to adopt this export). `answer === null` (zero-candidates short-circuit) → `'no_candidates'`; an answer that cites nothing → `'not_covered'`; at least one cited source → `'answered'`. The `'error'` outcome is **not** derived here — it belongs to the catch path (an `AskError`, where no `AskResult` exists), so each surface records it inline. Every ask writes exactly one `demand_log` row; `AskSource` carries no similarity/sessionId, so `top_similarity`/`top_session_id` stay null and `top_tier` is the best-ranked candidate's tier.

## Source shape

`AskSource { n, tier, dreamType?, ref, date, chunkId, trajectoryId?, cited }` — `ref` is the wiki slug or `repo@branch`. `AskResult { answer: string | null, sources, usage, model }`; `answer: null` ONLY for the zero-candidates case. `--json` carries all sources with their `cited` flag so a consumer can resolve any marker; the human output prints only cited sources.

## Cost / latency

One `wikiModel` call over ~12 × 2k-char snippets ≈ 6–10k prompt tokens (about a cent on gpt-5.4-mini) and ~5–20s; retrieval itself is local and free. Use `engram search` for raw hits at zero cost.

## Known gap (v0)

Citation fidelity is prompt-enforced only. The model can cite an out-of-range index (filtered by `extractCitedIndices`, the marker stays in the prose) or make an uncited claim. v0 accepts this; it is the gap the roadmap-#5 answer-quality eval will measure.
