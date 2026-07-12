import { statSync } from 'node:fs';
import type { EngramConfig } from '../types/index.ts';
import type { Embedder } from '../ingest/embed.ts';
import type { WikiBackend } from '../wiki/ingest.ts';
import { OpenAIDreamLLM } from '../dream/llm.ts';
import { OpenAIWikiLLM } from '../wiki/llm.ts';
import { synthesizeDreams } from '../dream/synthesize.ts';
import { ingestWiki } from '../wiki/ingest.ts';
import { WikiStore } from '../wiki/store.ts';
import { acquireSynthesisLock, type Lock } from './lock.ts';

// A session compiles only after this long WITHOUT a fresh ingest — every enqueue
// resets the timer, so an active session (repeated ingests) never re-dreams
// mid-flight (the O(N²) LLM-spend bug). An ended session compiles ~quiescence
// after its last ingest; a nightly synthesis-run is the backstop if the watcher
// dies before the timer fires (no persistence — in-process only).
const DEFAULT_QUIESCENCE_MS = 15 * 60_000;

export interface SynthesisQueueDeps {
  backend: WikiBackend;
  embedder: Embedder;
  config: EngramConfig;
  owner: string;
  // Injectable seams (tuning + tests). quiescenceMs defaults to 15 min.
  quiescenceMs?: number;
  acquireLock?: () => Lock | null;
  // The compile body (dream → wiki). Overridable so tests can assert scheduling
  // without spinning up real LLMs.
  compile?: (sessionId: string, repo: string) => Promise<void>;
  // "Is ingest still active on this file?" — true ⇒ the file changed within the
  // quiescence window, so we defer. Default stats the file; a missing/rotated
  // file (stat error) reads as not-active so an ended session still compiles.
  stillIngesting?: (path: string, quiescenceMs: number) => boolean;
}

// Serial, per-session quiescence-gated in-process queue that runs dream synthesis
// → wiki ingest for a just-ingested session. Gated behind synthesis.enabled by
// the caller; errors are logged, never propagated (the watcher must not crash).
export class SynthesisQueue {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private repos = new Map<string, string>();
  private paths = new Map<string, string>();
  private running = false;
  private readonly quiescenceMs: number;
  private readonly acquireLock: () => Lock | null;
  private readonly compile: (sessionId: string, repo: string) => Promise<void>;
  private readonly stillIngesting: (path: string, quiescenceMs: number) => boolean;

  constructor(private deps: SynthesisQueueDeps) {
    this.quiescenceMs = deps.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
    this.acquireLock = deps.acquireLock ?? acquireSynthesisLock;
    this.compile = deps.compile ?? ((sessionId, repo) => this.defaultCompile(sessionId, repo));
    this.stillIngesting =
      deps.stillIngesting ??
      ((path, quiescenceMs) => {
        try {
          return Date.now() - statSync(path).mtimeMs < quiescenceMs;
        } catch {
          return false; // missing/rotated → not active → proceed
        }
      });
  }

  enqueue(sessionId: string, repo: string, path?: string): void {
    if (!sessionId) return;
    this.repos.set(sessionId, repo);
    if (path) this.paths.set(sessionId, path);
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void this.run(sessionId, this.repos.get(sessionId) ?? repo);
      }, this.quiescenceMs)
    );
  }

  private async run(sessionId: string, repo: string): Promise<void> {
    const path = this.paths.get(sessionId);

    // Belt for the quiescence gate: if the file changed since the timer armed,
    // ingest is still active — re-arm rather than compile mid-session.
    if (path && this.stillIngesting(path, this.quiescenceMs)) {
      this.enqueue(sessionId, repo, path);
      return;
    }

    // Another session is compiling — re-arm without blocking the event loop.
    if (this.running) {
      this.enqueue(sessionId, repo, path);
      return;
    }

    this.running = true;
    const lock = this.acquireLock();
    if (!lock) {
      // Lock held by the nightly agent or a manual run — retry after quiescence.
      this.running = false;
      this.enqueue(sessionId, repo, path);
      return;
    }
    try {
      await this.compile(sessionId, repo);
      console.log(`[synthesis] compiled session ${sessionId.slice(0, 12)} (${repo || 'no repo'})`);
    } catch (err) {
      console.error(`[synthesis] session ${sessionId.slice(0, 12)} failed:`, err instanceof Error ? err.message : err);
    } finally {
      lock.release();
      this.running = false;
    }
  }

  private async defaultCompile(sessionId: string, _repo: string): Promise<void> {
    const { backend, embedder, config, owner } = this.deps;
    const dreamLlm = new OpenAIDreamLLM(config.openaiApiKey, config.dreamModel);
    const wikiLlm = new OpenAIWikiLLM(config.openaiApiKey, config.wikiModel);
    await synthesizeDreams(
      { sourceOwner: owner, dreamOwner: owner, sessionId, limit: 100, dryRun: false },
      { backend, embedder, llm: dreamLlm, config }
    );
    await ingestWiki(
      { sourceOwner: owner, wikiOwner: owner, limit: 100, dryRun: false },
      { backend, store: new WikiStore(config.wikiDir), embedder, llm: wikiLlm, config }
    );
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
