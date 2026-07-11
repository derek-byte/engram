# Agent memory systems — first-principles survey for engram

*2026-07-09. Method: 107-agent research workflow — 5 search angles → 25 primary sources fetched → 124 claims extracted → top 25 adversarially verified (3 skeptic votes each; 25/25 confirmed, 0 refuted). Zep/Graphiti and HippoRAG sections are adversarially verified; Generative Agents / RAPTOR / Mem0 / Letta sections are primary-source extracted with verbatim quotes but got only single-pass verification (budget cap) — labeled ⚠ below. All benchmark numbers are author-run unless noted; see "Benchmark skepticism" before trusting any of them.*

---

## 1. Zep / Graphiti — bi-temporal knowledge graph ✅ verified

**Data model.** Three hierarchical subgraphs, explicitly mirroring episodic/semantic human memory:
- **Episode subgraph** — raw messages/text/JSON, non-lossy, kept as provenance ("every derived fact traces back here"). ≈ engram's **raw** tier.
- **Semantic entity subgraph** — LLM-extracted entities plus **fact edges**: entity→relationship→entity triplets. ≈ engram's **dream** tier.
- **Community subgraph** — label-propagation clusters with LLM summaries. ≈ engram's **wiki** tier.

**The bi-temporal mechanism (the headline idea).** Every fact edge carries four timestamp fields on two independent timelines:
- `created_at` / `expired_at` — *transactional* time (when engram-the-system learned/retracted it)
- `valid_at` / `invalid_at` — *event* time (when the fact was true in the world)

Separating the two answers questions a single timestamp can't: "what did we believe on July 1?" (transactional) vs "what was true on July 1?" (event). Both `expired_at`/`invalid_at` are null until invalidation.

**Write path / supersession.** On ingest, an LLM compares each new edge against semantically related existing edges (dedup search constrained to the same entity pair). On temporally overlapping contradiction, the old edge's `invalid_at` is set to the new edge's `valid_at`. **Invalidate, never delete** — old facts remain as historical record. Known bug: during historical backfill, "new information wins" degrades to ingestion-order rather than event-order (Graphiti issue #1489).

**Retrieval.** Three-stage pipeline: hybrid search (cosine similarity + Okapi BM25 + n-hop breadth-first graph traversal) → fusion → optional rerank (RRF, MMR, episode-mention frequency, node distance, or cross-encoder). **No LLM in the default query path** — that's why it's ~139ms mean vs GraphRAG's seconds-to-tens-of-seconds LLM map-reduce. Context handed to the agent includes each fact's validity window.

**Staleness:** solved by design (above). **Multimodal:** nothing verified — no positive finding of image handling.

**Evals ⚠ (extracted, and disputed — see skepticism):** DMR 94.8% (gpt-4-turbo) vs MemGPT 93.4%; LongMemEval 71.2% vs 60.2% full-context with ~90% latency reduction; weak spot: single-session-assistant questions (80.4% vs 94.6% baseline).

---

## 2. HippoRAG 1 & 2 — hippocampal indexing + Personalized PageRank ✅ verified

**Theory.** Models memory on hippocampal indexing: the neocortex (LLM) holds representations; the hippocampus (a knowledge graph) holds an *index* over them; retrieval is *pattern completion* — activating part of a memory activates the rest (PageRank walk).

**Data model (v1).** At index time, an LLM does OpenIE over each passage → schema-less open KG whose nodes are noun phrases, edges are triples. Synonym edges connect similar nodes.

**Retrieval math (v1) — the part worth understanding precisely:**
1. LLM extracts named entities from the query; match them to KG nodes.
2. Seed Personalized PageRank with equal probability on matched nodes, each weighted by **node specificity** `s_i = |P_i|⁻¹` — inverse of how many passages the node appears in (a graph-native IDF: rare concepts steer the walk harder).
3. Run PPR to convergence → node distribution `n'`.
4. Passage score = `n' × P`, where `P` is the node-passage count matrix. Multi-hop association falls out of the walk: no iterative LLM retrieval needed.

**v2 refinements (exactly three):** (1) passage nodes added to the graph, linked to their phrases by "contains" edges (dense-sparse integration); (2) the *whole query* is embedded against *triple* embeddings instead of NER-to-node matching; (3) an LLM "recognition memory" filter screens retrieved triples before seeding. Passage nodes get seed probability from embedding similarity, down-weighted ×0.05.

**Evals:** v1: up to +20% recall@5 on multi-hop QA vs ColBERTv2; single-step matches iterative retrieval (IRCoT) at 10–30× cheaper / 6–13× faster (excludes offline OpenIE indexing cost; loses to ColBERTv2 on HotpotQA). v2: avg F1 59.8 vs 57.0 for NV-Embed-v2 across seven benchmarks; recall@5 +5.0 MuSiQue, +13.9 2Wiki. Author-run; the same tables show modern dense retrievers eroding v1's headline gap.

**Staleness: none at all.** Verifier full-text sweep found zero invalidation/editing/contradiction machinery — "continual learning" = monotonic corpus growth. **Multimodal: none.** Text-only pipeline.

**Critical warning for engram:** in HippoRAG 2's own eval, hierarchical-summary systems *regressed* on simple factual QA vs plain dense retrieval — RAPTOR 48.8 avg F1, GraphRAG 49.6, LightRAG 6.6 (as run by the HippoRAG team). Consolidation tiers must *augment* raw retrieval, never replace it. Engram's synth-default scope already respects this; keep it that way.

---

## 3. Generative Agents (Park et al., UIST '23) ⚠ extracted

**Data model.** A flat **memory stream**: every observation is a row with content, embedding, creation time, last-access time, and an LLM-assigned **importance** score (1–10, "how poignant is this?", assigned once at write time).

**Retrieval math (verbatim from the paper):**
```
score = α_recency·recency + α_importance·importance + α_relevance·relevance   (all α = 1)
```
- recency = exponential decay on *hours since last access* (decay factor 0.995 — note: last **access**, not creation; retrieved memories stay fresh, a rehearsal effect)
- importance = the write-time LLM scalar
- relevance = cosine similarity to the query
- each component min-max normalized to [0,1] first. **Additive, not multiplicative** (commonly misquoted — including by me earlier today).

**Reflection (their consolidation).** Periodically (importance-sum threshold), the agent asks "what 3 salient questions do these recent memories raise?", retrieves against them, and writes *reflections* — synthesized insights that cite their evidence memories — back into the same stream. Reflections can reflect on reflections: a consolidation pyramid, same instinct as dream/wiki.

**Staleness:** recency decay only — no invalidation. **Multimodal:** none (game-world observations). **Evals:** believability user-study ablations (full architecture > no-reflection > no-planning > no-observation), not retrieval benchmarks.

**For engram:** the scoring formula is the cheapest big idea in this survey — engram has relevance only. `timeDecayHalfLifeDays` exists and is off; dream types (decision/fix/gotcha/preference) are a free importance prior sitting unused.

---

## 4. RAPTOR (ICLR 2024) ⚠ extracted

**Mechanism.** Bottom-up tree: embed leaf chunks → soft-cluster (GMM over UMAP-reduced embeddings, cluster count picked by BIC; *soft* = a chunk can join multiple clusters) → LLM-summarize each cluster → embed summaries → recurse until one root. Retrieval: either tree traversal or **collapsed-tree** (flatten all levels into one pool, rank by similarity — this wins in their ablations). Queries hit the right abstraction level naturally: detail questions match leaves, thematic questions match summaries.

**Staleness/invalidation: none. Multimodal: none.** Static-corpus system; tree must be rebuilt or patched as data grows.

**Evals:** QuALITY 82.6% with GPT-4 (+20 pts absolute over prior SOTA), QASPER 55.7 F1, NarrativeQA 19.1 METEOR. But: 48.8 avg F1 in HippoRAG 2's hostile eval — regressing below plain dense retrieval on factual QA.

**For engram:** raw→dream→wiki *is* a RAPTOR tree with domain-aware (rather than GMM) clustering. Engram's `all`-scope search across tiers ≈ collapsed-tree retrieval — validation, nothing to import except the warning above.

---

## 5. Mem0 ⚠ extracted

**Write path (the interesting part).** Two-phase, per message pair:
1. **Extraction** — LLM produces candidate salient facts (input: the pair + conversation summary + recent window).
2. **Update** — for each fact, retrieve top-s similar existing memories, then an LLM picks one of four ops: **ADD / UPDATE / DELETE / NOOP**. Memory as CRUD with an LLM as the reconciliation engine.

**Mem0-g (graph variant):** directed labeled graph, entities as typed nodes with embeddings + creation timestamps, relations as triplets; conflict detector marks superseded relations *invalid rather than deleting* (Zep-lite temporal handling).

**Staleness:** only via the LLM choosing UPDATE/DELETE at write time (plus graph-variant invalid-marking). No decay, no TTL, no bi-temporal queries. **Multimodal:** none in the paper.

**Evals (their own paper):** LOCOMO J: Mem0 66.88%, Mem0-g 68.44% — **both losing to the trivial full-context baseline at 72.90%**. Their honest win is efficiency: p95 latency 1.44s vs 17.12s, ~7k tokens vs ~26k.

**For engram:** the ADD/UPDATE/DELETE/NOOP loop is what engram's wiki reconciliation already does at page granularity. Mem0's fact granularity is finer; its accuracy numbers argue engram's verbatim-first thesis (MemPalace lineage) is right — extraction-only memory loses information that full context keeps.

---

## 6. Letta / MemGPT ⚠ extracted

**MemGPT mechanism.** "Virtual context management" — an OS metaphor: the context window is RAM, external storage is disk, and **the LLM itself is the memory controller**, paging data in and out via self-invoked functions (page in archival results, page out/edit core memory) with interrupts for events.

**Letta's evolution — memory blocks:** a labeled, size-capped string (`label`, `description`, `value`, `limit`), individually persisted with a `block_id`. Context is **deterministically recompiled from DB state every request** — no similarity scoring for core memory; retrieval only for the archival tier. Blocks can be attached to multiple agents (shared memory). The agent *edits its own blocks* as it learns.

**Staleness:** agent-driven — the LLM overwrites its blocks; no temporal model. **Multimodal:** none found. **Evals:** original paper reports document-analysis and multi-session-chat wins over fixed-context baselines, no headline numbers in the abstract.

**For engram:** memory blocks ≈ a curated always-loaded tier — exactly what `engram context` injection is becoming (and what MemPalace's L0/L1 layers are, ~170-token wake-up). The idea worth stealing is the *size-capped, always-present, self-maintained summary block* per repo, recompiled deterministically — not similarity-retrieved.

---

## Benchmark skepticism (read before trusting any number above)

The LoCoMo benchmark — the main battleground — is largely discredited:
- **6.4% of its answer key is wrong** (99/1,540 questions; independent audit), capping the true max at ~93.6%.
- **Zep's famous 84%** contained an arithmetic error (adversarial-category answers counted in the numerator, excluded from the denominator). Zep's corrected self-run: 75.14%. Mem0's re-run of Zep's pipeline: 58.44%. Each vendor's re-run of the other is contested (single-user misconfiguration, timestamp handling, sequential-search latency inflation).
- **Full-context beats both** (~72.9–73%), and a trivial **Letta filesystem agent (GPT-4o-mini + grep) scored 74.0%** — beating every dedicated memory pipeline on the benchmark they market with.

Takeaway: vendor deltas on LoCoMo are noise. Engram's practice — benchmarking on its own corpus with self-retrieval + askeval — is the defensible approach. (Also noted by the sweep: MemPalace's zero-LLM write path + 96.6% LongMemEval remains ahead of LLM-extraction systems like Zep's ~85% on that harness.)

---

## What maps onto engram (synthesis)

| Idea | Source | Fit | Cost |
|---|---|---|---|
| `valid_at`/`invalid_at` columns + invalidate-don't-delete supersession | Zep | **Direct** — pgvector rows, no graph DB needed; wiki reconciliation already finds the contradictions, it just doesn't back-stamp the losers | Low (schema + write-path hook) |
| recency + importance in ranking | Generative Agents | **Direct** — `timeDecayHalfLifeDays` exists (off); dream types are a free importance prior | Trivial (config + rank formula) |
| Point-in-time queries ("what did I believe on X?") | Zep bi-temporal | Direct once validity columns exist | Low |
| Size-capped always-loaded block per repo, deterministically recompiled | Letta | Strong fit for `engram context` injection | Medium |
| Collapsed-tree cross-tier retrieval | RAPTOR | Already have it (`all` scope) | — |
| PPR associative retrieval | HippoRAG | **Incompatible as-is** — needs a graph substrate + corpus-wide node stats; open question whether recursive CTEs at engram's scale could fake it | High, defer |
| Fact-granular CRUD memory | Mem0 | Skip — its own evals lose to full context; engram's verbatim thesis is the counter-position | — |

**Architecture verdict:** engram's pyramid is the consensus shape (Zep's three tiers, RAPTOR's tree, GA's reflections all converge on it). What every verified system has that engram lacks is a **temporal validity model** — and what none of them have is multimodal capture, so images/files remain engram's differentiation opportunity, not a catch-up item.
