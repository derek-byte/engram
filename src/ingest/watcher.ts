import { watch, type FSWatcher } from 'chokidar';
import type { PipelineDeps } from './pipeline.ts';
import { fileIsStable, ingestFile } from './pipeline.ts';

export class SessionWatcher {
  private deps: PipelineDeps;
  private pending = new Map<string, NodeJS.Timeout>();
  private inFlight = new Set<string>();
  private watcher?: FSWatcher;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
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
    if (this.inFlight.has(path)) return;
    if (!fileIsStable(path, idleMs)) {
      this.schedule(path, idleMs);
      return;
    }

    this.inFlight.add(path);
    try {
      const result = await ingestFile(path, this.deps);
      if (result.embedded > 0 || result.skipped > 0) {
        console.log(
          `[ingest] ${path.split('/').pop()} — embedded ${result.embedded}, skipped ${result.skipped}`
        );
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
