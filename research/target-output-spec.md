# Target Output Spec — What Good Synthesis Looks Like

This is engram's **acceptance test** for synthesis quality. It is reverse-engineered from a
real, hand-written artifact: Derek's 4-month AngelList intern milestone log (Jan–May 2026),
which synthesized months of PRs, incidents, reviews, and notes into a coherent narrative.

Engram's job, stated concretely: **produce a doc like this, procedurally, continuously
maintained, for any body of work — so it never has to be written by hand again.**

The current wiki output (e.g. the contaminated "CS 247" page) is the anti-pattern. This is
the "after."

> Note: the source doc is NOT stored here. It contained a live production credential (scrubbed
> at the ingestion boundary — a hard requirement for any capture-everything system) and hundreds
> of `RTL:`-prefixed lines that are hyperlinks to actual GitHub PRs. Only the *structure* is
> captured below.

---

## The seven properties that made the hand-written log good

1. **Organized by INITIATIVE, not by repo or folder.**
   Top-level units were themes — "Startup Deduping," "Universal Search (special chars)," "Startup
   Web Enrichment," "Data Model Simplification." Each spanned many repos (`venture`,
   `support-services`, `usvc`), many PRs, weeks of time. Segmenting by repo would have shattered
   every one of them.
   → **Design consequence:** the node/bucket unit is the emergent semantic theme, discovered by
   clustering. Repo is a *weight/feature*, never the partition key.

2. **Threaded in time.** Each initiative reads as a trajectory: detection service → query
   optimization → workflow → cron → refinement → final bugfixes. Chronology is load-bearing;
   it's the "thought path," not a flat bag of facts.
   → **Design consequence:** trajectory edges (temporal, within-initiative) are first-class, not
   just semantic similarity edges.

3. **Learnings are extracted explicitly and separately.** The doc is full of "Learnings:" and
   "Notes:" — "reindex both changes or wait," "destructive migrations in their own PR," "counter-
   cache to reduce queries," "`touch` triggers reindex," "use `select(:id)` to let the DB do the
   work." These are the reusable, cross-project payoff.
   → **Design consequence:** engram's extraction schema (today: decision / fix / gotcha /
   preference) is MISSING a **learning / concept** category. This doc proves it's load-bearing.

4. **Incidents carry problem → root cause → solution → learning.** Each incident (ES reindex OOM,
   merge deadlock, orphaned FK failures, silent `.update` validation failure) is a complete
   causal unit, not a log line.
   → **Design consequence:** an incident/postmortem is a typed node shape with required slots.

5. **People, tools, and systems are linked entities.** Named leads, engineers, the systems touched
   (Elasticsearch/BM25, Redis, Sidekiq, Flowdash, CPTR, Clearbit/Exa, Datadog). These become
   cross-cutting anchor nodes that many initiatives link into.
   → **Design consequence:** entity nodes (person / tool / system) are the stable skeleton the
   activity-derived theme nodes attach to. External references (papers, docs) are the same class.

6. **Recurring patterns surface across initiatives.** The same rules recur — reindex discipline,
   migration-in-own-PR, caching to cut DB load, scoring engines with weighted signals. These are
   exactly what should resurface on a relevant future query ("optimal queries").
   → **Design consequence:** community detection over the graph should surface these recurring
   themes as higher-order summary nodes.

7. **Provenance is preserved, identity is not merged.** Every claim traces to specific PRs/links,
   yet distinct initiatives stay distinct even when they share repos and systems. Cross-links
   without contamination.
   → **Design consequence:** "link, don't merge." Typed weighted edges between nodes; never collapse
   two initiatives onto one page because they touched the same repo.

---

## Structural template (per initiative node)

```
# <Initiative theme>                         ← emergent cluster label, not a repo name
Timespan: <first touch> – <last touch>       ← trajectory bounds
Repos touched: <weighted list>               ← signal, not identity
Systems / tools: [[elasticsearch]] [[sidekiq]] [[flowdash]] ...   ← linked entity nodes
People: [[...]]                              ← linked entity nodes

## Narrative (time-threaded)
<problem → approach → iterations → outcome, as a trajectory>

## PRs / artifacts
- <link to PR>   ← RTL-style lines were hyperlinks to real GitHub PRs; preserve as edges to
                   artifact nodes, don't inline the diff

## Incidents
- <problem → root cause → solution → learning>

## Learnings (reusable, cross-project)
- <concept / rule that should resurface on future related queries>

## Links
- related initiatives, shared systems, prior art (external reference nodes)
```

---

## How this maps onto engram's layers

| Layer | Today | Target (per this spec) |
|---|---|---|
| chunks (raw) | trajectory-based ✓ | keep |
| dream | decision/fix/gotcha/preference | **add `learning` + `incident` types** |
| wiki | LLM freely writes repo-ish entity pages → contamination | **cluster dream chunks into initiative themes (repo = weight); one node per theme; link, don't merge** |
| index | flat | **community-detection summaries over the theme graph** |
| query | hybrid vector/keyword | **graph-expanded (spreading activation) so recurring learnings resurface** |

This table is the bridge from the diagnosed failure (CS 247 contamination) to the researched
architecture (clustering-first nodes, repo-as-weight, emergent graph, community summaries). The
cited method survey lives alongside this file once the research pass lands.
