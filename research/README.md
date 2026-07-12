# Research — Emergent Knowledge Graph / "Second Brain" for engram

Cited method survey behind engram's next architecture: auto-discovering structure across
projects **without** hard-partitioning by repo. Companion to [`target-output-spec.md`](./target-output-spec.md)
(the acceptance test) — this file is the *how*.

Method: 6 search angles → 25 sources fetched → 112 claims extracted → top 25 adversarially
verified (3-vote, need 2/3 to refute). **25/25 confirmed, 0 refuted.** Run: 108 agents,
2026-07-05. Primary sources current to Jan 2026 cutoff (latest: BERTopic v0.17.4, 2025-12-03).

---

## Verdict on each method

| Method | Real? | Role for engram |
|---|---|---|
| **HippoRAG** (NeurIPS 2024) + **HippoRAG 2** (ICML 2025) | ✅ verified | Personalized-PageRank over a KG for single-step multi-hop retrieval — the "link related work across projects" query primitive |
| **Microsoft GraphRAG** (Edge et al. 2024) | ✅ verified | Hierarchical Leiden communities + auto-generated community reports — replaces hand-titled wiki pages; merges nodes ONLY on exact identity |
| **BERTopic** (Grootendorst 2022, v0.17.4) | ✅ verified | UMAP→HDBSCAN→c-TF-IDF over embeddings — the "auto-create buckets" primitive; default embedder is all-MiniLM-L6-v2 = **engram's exact 384-dim model** |
| **Community detection over semantic k-NN** (Markov Stability; ECCD 2024) | ✅ verified | Node discovery without setting `k`, no LLM in the clustering loop; embedding-augmented detection wins most on *noisy* graphs (engram's regime) |
| **Generative Agents** reflection (Park et al., UIST 2023) | ⚠️ not re-verified this run | Precedent for cluster→synthesize. Dropped from the verify queue by budget, **not refuted**; it's real (I'm confident) but this pass didn't independently confirm it |

---

## Sources (by angle, primary-first)

### HippoRAG — PPR-over-KG retrieval
- [arXiv:2405.14831](https://arxiv.org/abs/2405.14831) — *HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs* (NeurIPS 2024). **primary.** LLM OpenIE → schemaless KG; PPR spreads from query concepts for one-step multi-hop. 89.1% vs 68.2% R@5 on 2WikiMultiHopQA over ColBERTv2.
- [arXiv:2502.14802](https://arxiv.org/abs/2502.14802) — *HippoRAG 2* (ICML 2025). **primary.** Dual-node passage+phrase graph; +7% associative memory. *Caveat: factual/sense-making margins are ~1–2 F1 ties; the robust win is multi-hop — exactly engram's use case.*
- [github.com/osu-nlp-group/hipporag](https://github.com/osu-nlp-group/hipporag) — official repo. **primary.**

### Microsoft GraphRAG — communities + summaries
- [arXiv:2404.16130v2](https://arxiv.org/html/2404.16130v2) — *From Local to Global: A GraphRAG Approach* (Edge et al., Microsoft). **primary.** Entities (title/type/description) + weighted relationships (0–10 strength); **merge only on same title+type**; recursive hierarchical Leiden; per-community reports; map-reduce global query.
- [microsoft.github.io/graphrag](https://microsoft.github.io/graphrag/index/default_dataflow/) — official dataflow docs. **primary.**
- [graphrag.com/reference](https://graphrag.com/reference/knowledge-graph/lexical-graph-extracted-entities-community-summaries/) — secondary reference. *Caveat: default relationships are free-text + strength, not a fixed edge-type taxonomy — "typed edges" needs an added taxonomy layer.*

### BERTopic — auto-clustering primitive
- [arXiv:2203.05794](https://ar5iv.labs.arxiv.org/html/2203.05794) — *BERTopic: Neural topic modeling with class-based TF-IDF* (Grootendorst 2022). **primary.** SBERT → UMAP → HDBSCAN → c-TF-IDF; HDBSCAN models outliers as noise (contamination prevention); topic count emergent, not preset.
- [maartengr.github.io/BERTopic](https://maartengr.github.io/BERTopic/index.html) — official docs (6 swappable steps). **primary.**
- [pypi.org/project/bertopic](https://pypi.org/project/bertopic/) — v0.17.4, 2025-12-03. **primary.**
- [arXiv:2412.14486](https://arxiv.org/pdf/2412.14486), [arXiv:2410.09063](https://arxiv.org/pdf/2410.09063) — supporting studies (LLM-summary preprocessing improves topic diversity). **primary.**
- [topicbert blog](https://www.maartengrootendorst.com/blog/topicbert/) — author blog. **blog.**

### Community detection over semantic k-NN (vs LLM extraction)
- [J. Complex Networks 12(4) cnae035 (2024)](https://academic.oup.com/comnet/article/12/4/cnae035/7736903) — embedding-supported detection improves NMI **3.20–10.14% when structure is weak** vs 0.03–0.25% when strong. **primary.** *Caveat: uses graph-topology embeddings on synthetic ABCD graphs — direction transfers to semantic k-NN, magnitude doesn't.*
- [Applied Network Science (2019/2020), DOI 10.1007/s41109-019-0248-7](https://link.springer.com/article/10.1007/s41109-019-0248-7) — Markov Stability multiscale detection; estimates cluster count, no preset `k`. **primary.**
- [Louvain→Leiden (Traag et al.)](https://www.semanticscholar.org/paper/From-Louvain-to-Leiden:-guaranteeing-well-connected-Traag-Waltman/79cdbabb22ef80074f5659430fe6fc97932798f5), [arXiv:2502.09891](https://arxiv.org/html/2502.09891). **primary.**

### Generative Agents — reflection precedent
- [ACM UIST 2023 full text](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763), [arXiv:2304.03442](https://arxiv.org/abs/2304.03442). **primary.** Memory stream + periodic reflection (cluster salient memories → synthesize higher-level observations). Retrieval = recency·importance·relevance.
- [Affordable Generative Agents arXiv:2402.02053](https://arxiv.org/pdf/2402.02053) — cost reduction. **primary.**

### "Link, don't merge" — provenance + typed cross-doc edges
- [GraphRAG entity-resolution failure](https://www.sowmith.dev/blog/graphrag-entity-disambiguation) — below ~85% resolution accuracy the KG goes "toxic" (unrelated things merged). Names engram's exact failure. **blog.**
- [Unbundling the graph in GraphRAG (O'Reilly)](https://www.oreilly.com/radar/unbundling-the-graph-in-graphrag/), [Proxy-Pointer RAG](https://towardsdatascience.com/proxy-pointer-rag-solving-entity-and-relationship-sprawl-in-large-knowledge-graphs/). **blog.**

---

## Recommended architecture (synthesis — confidence: medium)

Evolve `dream → wiki → search` to **clustering-first node discovery + persisted typed-weighted graph + PPR retrieval**:

- **(a) Node discovery** — cluster dream-chunk embeddings with UMAP→HDBSCAN (BERTopic, reusing existing MiniLM 384-dim vectors); node count emerges. **Mandatory outlier-reduction pass** — HDBSCAN dumps 18–28%+ of docs to noise by default; that's the same mechanism that prevents contamination, so reduce, don't discard.
- **(b) Repo as weighted feature, NOT partition** — add a repo-affinity term to edge weight (small same-repo boost + directory-ancestry boost so parent/child sessions attract). Clusters cohere around repos without being walled off; semantically-close cross-repo chunks still link. *The chunker already carries repo/cwd/branch per trajectory — this is powered by existing data.*
- **(c) Auto-title pages** via c-TF-IDF keywords (optionally LLM-polished). Each cluster = an emergent page, replacing hand-titled wiki pages.
- **(d) Persist a typed weighted edge table** (source, target, weight, originating repo/session) — replaces the current derive-on-demand `[[slug]]` scan. Cross-project links become first-class; identity is never merged away.
- **(e) Optional** hierarchical Leiden → GraphRAG-style community summaries for global cross-project queries.
- **(f) Retrieval** — PPR (HippoRAG) seeded on query-matched nodes for multi-hop.

**Staged migration:** keep current pipeline → add clustering as node-discovery + edge table as a *parallel* index → cut retrieval to PPR once the graph is populated. **Prototype clustering on the existing ~897-chunk corpus first** to tune HDBSCAN `min_cluster_size` against the noise-rate caveat before committing.

---

## Open questions (unresolved by the research)

1. **Repo-affinity weighting function** — fixed additive boost, learned weight, or directory-tree distance decay? How tuned so parent/child sessions connect without collapsing distinct projects?
2. **LLM entity extraction (HippoRAG/GraphRAG) vs pure embedding-clustering (BERTopic/Markov Stability) vs hybrid** — cost/latency of LLM extraction over a growing local corpus vs interpretability of extracted entities.
3. **Is PPR + hierarchical Leiden premature at 897 chunks?** What corpus size justifies the complexity over vector search + a simple persisted edge table?
4. **Generative Agents reflection vs GraphRAG community reports** for the summarization step — which fits engram's dream→wiki better? (And re-verify Generative Agents independently.)

---

## Caveats carried from verification

- Community-detection benefit numbers are from **synthetic graph-topology** embeddings, not semantic text embeddings — direction transfers, magnitude unproven.
- HippoRAG 2 "comprehensive" superiority overstates — only multi-hop is a robust win.
- HDBSCAN contamination-prevention is double-edged (silently drops large corpus fractions) — outlier reduction is mandatory.
- GraphRAG edges are free-text+strength, not typed — engram needs an added taxonomy layer.
- The recommended architecture is a **composition inference, not a benchmarked design** — validate on engram's real corpus before building.
