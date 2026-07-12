# synthesis/

The synthesis orchestration layer: it sits **above** `ingest/`, `dream/`, and
`wiki/` and stitches them into the dream → wiki compile flow. Depending downward
only (`dream`, `wiki`, `storage`, `config`, `types`), it exists so the low ingest
layer never reaches up to the high dream/wiki layers — the watcher fires an
`onIngested` hook and the **command layer** (`commands/watch.ts`) wires that hook
to the queue, keeping composition at the top where it belongs.

- **`synthesisQueue.ts`** — `SynthesisQueue`: a serial, per-session,
  quiescence-gated in-process queue. Every `enqueue` resets a 15-min timer so an
  active session (repeated ingests) never re-dreams mid-flight; an ended session
  compiles ~quiescence after its last ingest (dream synthesis → wiki ingest).
  Gated behind `synthesis.enabled` + an OpenAI key by the caller; errors are
  logged, never propagated (the watcher must not crash). A nightly `synthesis-run`
  is the backstop if the watcher dies before the timer fires (in-process only, no
  persistence). All seams (`compile`, `acquireLock`, `stillIngesting`,
  `quiescenceMs`) are injectable for tests.
- **`lock.ts`** — best-effort advisory lock (`~/.engram/synthesis.lock`) shared by
  the queue, `dream`, `wiki ingest`, and the nightly `synthesis-run` (stale after
  30 min, 6h hard cap) so the watcher hook, nightly agent, and manual runs can't
  interleave LLM synthesis. Atomic `O_EXCL` create + rename-verify stale-claim
  (no TOCTOU); a heartbeat keeps a live holder fresh. The CLI commands import it
  downward from here.
