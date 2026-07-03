import type { EngramConfig } from '../types/index.ts';
import type { Embedder } from './embed.ts';
import type { WikiBackend } from '../wiki/ingest.ts';
import { OpenAIDreamLLM } from '../dream/llm.ts';
import { OpenAIWikiLLM } from '../wiki/llm.ts';
import { synthesizeDreams } from '../dream/synthesize.ts';
import { ingestWiki } from '../wiki/ingest.ts';
import { WikiStore } from '../wiki/store.ts';
import { acquireSynthesisLock } from '../commands/synthesisLock.ts';

const DEBOUNCE_MS = 60_000;

export interface SynthesisQueueDeps {
  backend: WikiBackend;
  embedder: Embedder;
  config: EngramConfig;
  owner: string;
}

// Serial, per-session-debounced in-process queue that runs dream synthesis → wiki
// ingest for a just-ingested session. Gated behind synthesis.enabled by the caller;
// errors are logged, never propagated (the watcher must not crash).
export class SynthesisQueue {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private repos = new Map<string, string>();
  private running = false;

  constructor(private deps: SynthesisQueueDeps) {}

  enqueue(sessionId: string, repo: string): void {
    if (!sessionId) return;
    this.repos.set(sessionId, repo);
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void this.run(sessionId, this.repos.get(sessionId) ?? repo);
      }, DEBOUNCE_MS)
    );
  }

  private async run(sessionId: string, repo: string): Promise<void> {
    if (this.running) {
      // Re-debounce so we don't interleave; try again shortly.
      this.enqueue(sessionId, repo);
      return;
    }
    this.running = true;
    const lock = acquireSynthesisLock();
    if (!lock) {
      this.running = false;
      return;
    }
    try {
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
      console.log(`[synthesis] compiled session ${sessionId.slice(0, 12)} (${repo || 'no repo'})`);
    } catch (err) {
      console.error(`[synthesis] session ${sessionId.slice(0, 12)} failed:`, err instanceof Error ? err.message : err);
    } finally {
      lock.release();
      this.running = false;
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
