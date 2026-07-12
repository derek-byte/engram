import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PrefixCache } from '../src/ingest/contextPrefix.ts';

// A JSONL-backed PrefixCache for the retrieval A/B harness. Deliberately NOT a pg
// table: the bench databases are dropped on teardown, and a table in the LIVE db
// would violate the "never write a row to derek's database" invariant. A local
// JSONL file is crash-safe (append + flush per prefix), human-inspectable, and
// survives across --skip-ingest re-runs so the ~12k-call prefix pass happens once.
//
// Line format: {"sha":"…","model":"…","prefix":"…"}. In-memory index keyed
// `${model}\n${sha}` so arms B and D (same generator model) share one cache.
export const DEFAULT_PREFIX_CACHE_PATH = join('benchmarks', '.cache', 'prefix-cache.jsonl');

export class JsonlPrefixCache implements PrefixCache {
  private store = new Map<string, string>();

  constructor(private path: string = DEFAULT_PREFIX_CACHE_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const o = JSON.parse(trimmed) as { sha?: unknown; model?: unknown; prefix?: unknown };
          if (typeof o.sha === 'string' && typeof o.model === 'string' && typeof o.prefix === 'string') {
            this.store.set(this.key(o.sha, o.model), o.prefix);
          }
        } catch {
          // Skip a corrupt/partial line (e.g. a crash mid-append) — the rest load.
        }
      }
    }
  }

  private key(sha: string, model: string): string {
    return `${model}\n${sha}`;
  }

  async getCachedPrefixes(shas: string[], model: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const sha of shas) {
      const hit = this.store.get(this.key(sha, model));
      if (hit !== undefined) out.set(sha, hit);
    }
    return out;
  }

  async putCachedPrefixes(entries: Array<{ sha: string; prefix: string }>, model: string): Promise<void> {
    let batch = '';
    for (const e of entries) {
      const k = this.key(e.sha, model);
      if (this.store.has(k)) continue; // append-once, mirror ON CONFLICT DO NOTHING
      this.store.set(k, e.prefix);
      batch += JSON.stringify({ sha: e.sha, model, prefix: e.prefix }) + '\n';
    }
    if (batch) appendFileSync(this.path, batch);
  }
}
