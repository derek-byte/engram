import { watch, type FSWatcher } from 'chokidar';
import type { PipelineDeps } from './pipeline.ts';
import { fileIsStable, ingestFile } from './pipeline.ts';

export interface WatcherHooks {
  // `path` is the session .jsonl that was just ingested, so the synthesis queue
  // can re-check file stability at fire time (belt for the quiescence gate).
  onIngested(sessionId: string, repo: string, embedded: number, path: string): void;
}

export class SessionWatcher {
  private deps: PipelineDeps;
  private hooks?: WatcherHooks;
  private pending = new Map<string, NodeJS.Timeout>();
  private inFlight = new Set<string>();
  private watcher?: FSWatcher;

  constructor(deps: PipelineDeps, hooks?: WatcherHooks) {
    this.deps = deps;
    this.hooks = hooks;
  }

  start(): void {
    const idleMs = this.deps.config.sessionCompleteDelaySec * 1000;

    this.watcher = watch(this.deps.config.watchPath, {
      persistent: true,
      ignoreInitial: false,
      depth: 3,
      awaitWriteFinish: false,
    });

    this.watcher
      .on('add', (path: string) => this.schedule(path, idleMs))
      .on('change', (path: string) => this.schedule(path, idleMs))
      .on('error', (err: unknown) => console.error('[watcher]', err));

    console.log(`[watcher] watching ${this.deps.config.watchPath}`);
  }

  private schedule(path: string, idleMs: number): void {
    if (!path.endsWith('.jsonl')) return;

    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(path);
      void this.process(path, idleMs);
    }, idleMs);

    this.pending.set(path, timer);
  }

  private async process(path: string, idleMs: number): Promise<void> {
    // V9b: a change that arrives while this file is mid-ingest must not be
    // dropped — reschedule it so the newer bytes get picked up after the flight.
    if (this.inFlight.has(path)) {
      this.schedule(path, idleMs);
      return;
    }
    if (!fileIsStable(path, idleMs)) {
      this.schedule(path, idleMs);
      return;
    }

    this.inFlight.add(path);
    try {
      const result = await ingestFile(path, this.deps);
      if (result.embedded > 0 || result.skipped > 0) {
        console.log(
          `[ingest] ${path.split('/').pop()} — embedded ${result.embedded}, skipped ${result.skipped}, cache ${result.cacheHits}h/${result.cacheMisses}m`
        );
      }
      if (result.embedded > 0 && this.hooks) {
        try {
          this.hooks.onIngested(result.sessionId, result.repo, result.embedded, path);
        } catch (err) {
          console.error('[synthesis] hook error:', err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.error(`[ingest] ${path}:`, err instanceof Error ? err.message : err);
    } finally {
      this.inFlight.delete(path);
    }
  }

  async stop(): Promise<void> {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    await this.watcher?.close();
  }
}
