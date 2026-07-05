import { Database } from 'bun:sqlite';
import { ensureEngramDir, resolveLocalDbPath } from '../config/index.ts';

export interface CursorRow {
  sessionId: string;
  chunkOffset: number;
  processedAt: string;
}

// The full ingest cursor for a session: the slice offset plus the supersession
// bookkeeping (V2). lastTrajectoryId/lastChunkIds record the trajectory that sat
// at the cursor position on the previous successful ingest, so the next ingest
// can detect in-place growth of that turn and retract its stale raw chunks.
export interface CursorState {
  chunkOffset: number;
  lastTrajectoryId: string | null;
  lastChunkIds: string[];
}

// Recency-ranked usage log powering the UI's empty-state and, later, the
// demand-driven-synthesis signal. Kept intentionally general: `kind` is
// unconstrained, `key` round-trips any reopenable thing ('wiki:<slug>',
// 'traj:<id>', or a raw query).
export const RECENTS_CAP = 200;

export interface RecentRow {
  kind: string;
  key: string;
  label: string;
  timestamp: string;
}

// Similarity floor below which a search "found something" but not something
// good enough to count as met demand. One place, referenced by the unmet-demand
// query here and by the demand report/synthesis surfaces that build on it.
export const UNMET_THRESHOLD = 0.35;

// Retention window for demand_log; rows older than this are pruned on write.
export const DEMAND_RETENTION_DAYS = 90;

// One logged demand event. `surface`/`kind` are constrained; the outcome fields
// are ask-only (search rows leave `outcome`/`citedCount` null). `topSessionId`
// is the targeted-synthesis handle for the best-matching raw material.
export interface DemandRow {
  surface: 'ui' | 'cli' | 'mcp';
  kind: 'search' | 'ask';
  query: string;
  tier?: string | null;
  repo?: string | null;
  resultCount?: number | null;
  topSimilarity?: number | null;
  topTier?: string | null;
  topSessionId?: string | null;
  outcome?: 'answered' | 'not_covered' | 'no_candidates' | 'error' | null;
  citedCount?: number | null;
}

// One grouped row of the unmet-demand report: a normalized query, how often it
// went unmet, when it was last seen, and the raw-material session that best
// matched it (from the group's highest-similarity row) for targeted synthesis.
export interface UnmetDemandRow {
  query: string;
  count: number;
  latestTs: string;
  topSessionId: string | null;
  // Tier of the group's best hit. 'raw' means uncompiled material exists — the
  // only case demand-targeted synthesis should spend its nightly budget on.
  topTier: string | null;
}

// Aggregate counters over the demand window, for the `engram demand` header and
// the synthesis-run `demand` phase line.
export interface DemandSummary {
  days: number;
  total: number;
  searches: number;
  asks: number;
  unmet: number;
  unmetQueries: number;
}

// Trend/history retention caps. Snapshots keep the last SNAPSHOTS_CAP rows per
// kind (matches the analytics sparkline window); askeval_runs is unbounded-ish
// but trimmed to the newest ASKEVAL_CAP on insert so the table never grows
// without bound.
export const SNAPSHOTS_CAP = 120;
export const ASKEVAL_CAP = 50;

// One trend snapshot: a timestamped JSON payload tagged by kind ('demand' |
// 'lint'). Payload is parsed on read.
export interface SnapshotRow {
  id: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

// One askeval run record. summary/reports are JSON blobs, parsed on read (null
// while a run is still 'running' or if none was written).
export interface AskevalRunRow {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  summary: unknown;
  reports: unknown;
}

// Context-injection activity over a window: total fires, last fire, and the
// last-7-day count (for the Analytics card's "how often does injection fire").
export interface ContextStats {
  count: number;
  lastTs: string | null;
  last7d: number;
}

// SQL predicate defining "unmet" demand (plan (c)(1)): an ask that resolved to
// not_covered/no_candidates, or a search that found nothing / nothing good.
const UNMET_PREDICATE = `(
  (kind = 'ask' AND outcome IN ('not_covered', 'no_candidates'))
  OR (kind = 'search' AND (result_count = 0 OR top_similarity < ${UNMET_THRESHOLD}))
)`;

export class LocalStore {
  private db: Database;

  constructor(path: string = resolveLocalDbPath()) {
    ensureEngramDir();
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursor (
        session_id TEXT PRIMARY KEY,
        chunk_offset INTEGER NOT NULL,
        processed_at TEXT NOT NULL,
        last_trajectory_id TEXT,
        last_chunk_ids TEXT
      );

      CREATE TABLE IF NOT EXISTS seen_hashes (
        hash TEXT PRIMARY KEY,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ingestion_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trajectory TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS stats (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS recents_ts ON recents (timestamp DESC, id DESC);

      CREATE TABLE IF NOT EXISTS demand_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        surface TEXT NOT NULL,           -- 'ui' | 'cli' | 'mcp'
        kind TEXT NOT NULL,              -- 'search' | 'ask'
        query TEXT NOT NULL,
        tier TEXT, repo TEXT,
        result_count INTEGER,
        top_similarity REAL,
        top_tier TEXT,                   -- 'raw' ⇒ covered by history, uncompiled
        top_session_id TEXT,             -- targeted-synthesis handle
        outcome TEXT,                    -- ask: 'answered'|'not_covered'|'no_candidates'|'error'; search: NULL
        cited_count INTEGER
      );

      CREATE INDEX IF NOT EXISTS demand_ts ON demand_log (ts);

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        kind TEXT NOT NULL,        -- 'demand' | 'lint'
        payload TEXT NOT NULL      -- JSON
      );

      CREATE INDEX IF NOT EXISTS snapshots_kind_ts ON snapshots (kind, ts);

      CREATE TABLE IF NOT EXISTS askeval_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL,      -- 'running'|'done'|'error'
        summary TEXT, reports TEXT -- JSON blobs
      );

      CREATE TABLE IF NOT EXISTS context_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        repo TEXT NOT NULL,
        pages INTEGER NOT NULL, memories INTEGER NOT NULL, est_tokens INTEGER NOT NULL
      );
    `);

    // V2 supersession columns for cursor tables created before this migration.
    this.ensureColumn('cursor', 'last_trajectory_id', 'TEXT');
    this.ensureColumn('cursor', 'last_chunk_ids', 'TEXT');
  }

  // Add a column to an existing table if it isn't already present (bun:sqlite has
  // no ADD COLUMN IF NOT EXISTS). Used to evolve the cursor table in place.
  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  // Log a usage event. Collapses noise: if the newest row of the same kind has
  // the same key — or (search only) the newest key is a strict prefix of the
  // new key, i.e. search-as-you-type refinement — the existing row is updated
  // in place instead of appending. Then trims to the RECENTS_CAP newest rows.
  logRecent(kind: string, key: string, label: string): void {
    const newest = this.db
      .query<{ id: number; key: string }, [string]>(
        'SELECT id, key FROM recents WHERE kind = ? ORDER BY timestamp DESC, id DESC LIMIT 1'
      )
      .get(kind);
    const replace =
      newest && (newest.key === key || (kind === 'search' && key.startsWith(newest.key) && key !== newest.key));
    if (replace) {
      this.db
        .query("UPDATE recents SET key = ?, label = ?, timestamp = datetime('now') WHERE id = ?")
        .run(key, label, newest!.id);
    } else {
      this.db.query('INSERT INTO recents (kind, key, label) VALUES (?, ?, ?)').run(kind, key, label);
    }
    this.db
      .query('DELETE FROM recents WHERE id NOT IN (SELECT id FROM recents ORDER BY timestamp DESC, id DESC LIMIT ?)')
      .run(RECENTS_CAP);
  }

  getRecents(limit = 50): RecentRow[] {
    return this.db
      .query<RecentRow, [number]>('SELECT kind, key, label, timestamp FROM recents ORDER BY timestamp DESC, id DESC LIMIT ?')
      .all(limit);
  }

  // Append a demand event, then prune rows older than the retention window.
  // Search rows collapse search-as-you-type noise the same way logRecent does:
  // if the newest search row's query equals — or is a strict prefix of — the
  // new query, the existing row is rewritten in place instead of appended. Ask
  // rows always append (one row per runAsk, carrying its outcome).
  logDemand(row: DemandRow): void {
    const values: [
      string,
      string,
      string | null,
      string | null,
      number | null,
      number | null,
      string | null,
      string | null,
      string | null,
      number | null,
    ] = [
      row.surface,
      row.query,
      row.tier ?? null,
      row.repo ?? null,
      row.resultCount ?? null,
      row.topSimilarity ?? null,
      row.topTier ?? null,
      row.topSessionId ?? null,
      row.outcome ?? null,
      row.citedCount ?? null,
    ];

    let collapsed = false;
    if (row.kind === 'search') {
      const newest = this.db
        .query<{ id: number; query: string }, []>(
          "SELECT id, query FROM demand_log WHERE kind = 'search' ORDER BY ts DESC, id DESC LIMIT 1"
        )
        .get();
      const replace =
        newest && (newest.query === row.query || (row.query.startsWith(newest.query) && row.query !== newest.query));
      if (replace) {
        this.db
          .query(
            `UPDATE demand_log SET
               ts = datetime('now'), surface = ?, query = ?, tier = ?, repo = ?,
               result_count = ?, top_similarity = ?, top_tier = ?, top_session_id = ?,
               outcome = ?, cited_count = ?
             WHERE id = ?`
          )
          .run(...values, newest.id);
        collapsed = true;
      }
    }

    if (!collapsed) {
      const [surface, query, ...rest] = values;
      this.db
        .query(
          `INSERT INTO demand_log
             (surface, kind, query, tier, repo, result_count, top_similarity, top_tier, top_session_id, outcome, cited_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(surface, row.kind, query, ...rest);
    }

    this.db.query("DELETE FROM demand_log WHERE ts < datetime('now', ?)").run(`-${DEMAND_RETENTION_DAYS} days`);
  }

  // Unmet demand over the last `days`, grouped by normalized (lowercased) query.
  // Each group carries its occurrence count, the most recent ts, and the
  // top_session_id from the group's highest-similarity row (the best raw
  // material to synthesize against). Ordered most-demanded first.
  unmetDemand(days = 30): UnmetDemandRow[] {
    const rows = this.db
      .query<
        { query: string; top_similarity: number | null; top_session_id: string | null; top_tier: string | null; ts: string },
        [string]
      >(
        `SELECT query, top_similarity, top_session_id, top_tier, ts
           FROM demand_log
          WHERE ts >= datetime('now', ?) AND ${UNMET_PREDICATE}`
      )
      .all(`-${days} days`);

    const groups = new Map<string, UnmetDemandRow & { bestSim: number }>();
    for (const r of rows) {
      const key = r.query.toLowerCase();
      const sim = r.top_similarity ?? -Infinity;
      const g = groups.get(key);
      if (!g) {
        groups.set(key, {
          query: key,
          count: 1,
          latestTs: r.ts,
          topSessionId: r.top_session_id,
          topTier: r.top_tier,
          bestSim: sim,
        });
        continue;
      }
      g.count++;
      if (r.ts > g.latestTs) g.latestTs = r.ts;
      if (sim > g.bestSim) {
        g.bestSim = sim;
        g.topSessionId = r.top_session_id;
        g.topTier = r.top_tier;
      }
    }

    return [...groups.values()]
      .map(({ bestSim: _bestSim, ...g }) => g)
      .sort((a, b) => b.count - a.count || (a.latestTs < b.latestTs ? 1 : -1));
  }

  // Aggregate counters over the demand window: totals, split by kind, and the
  // unmet volume (raw rows + distinct normalized queries).
  demandSummary(days = 30): DemandSummary {
    const window = `-${days} days`;
    const totals = this.db
      .query<{ total: number; searches: number; asks: number }, [string]>(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE kind = 'search') AS searches,
           COUNT(*) FILTER (WHERE kind = 'ask') AS asks
         FROM demand_log WHERE ts >= datetime('now', ?)`
      )
      .get(window)!;
    const unmet = this.db
      .query<{ unmet: number }, [string]>(
        `SELECT COUNT(*) AS unmet FROM demand_log WHERE ts >= datetime('now', ?) AND ${UNMET_PREDICATE}`
      )
      .get(window)!;
    return {
      days,
      total: totals.total,
      searches: totals.searches,
      asks: totals.asks,
      unmet: unmet.unmet,
      unmetQueries: this.unmetDemand(days).length,
    };
  }

  getCursor(sessionId: string): number {
    const row = this.db
      .query<{ chunk_offset: number }, [string]>('SELECT chunk_offset FROM cursor WHERE session_id = ?')
      .get(sessionId);
    return row?.chunk_offset ?? 0;
  }

  // Full cursor row including the V2 supersession bookkeeping. Missing session →
  // offset 0, no recorded last trajectory.
  getCursorState(sessionId: string): CursorState {
    const row = this.db
      .query<{ chunk_offset: number; last_trajectory_id: string | null; last_chunk_ids: string | null }, [string]>(
        'SELECT chunk_offset, last_trajectory_id, last_chunk_ids FROM cursor WHERE session_id = ?'
      )
      .get(sessionId);
    if (!row) return { chunkOffset: 0, lastTrajectoryId: null, lastChunkIds: [] };
    let lastChunkIds: string[] = [];
    if (row.last_chunk_ids) {
      try {
        const parsed = JSON.parse(row.last_chunk_ids);
        if (Array.isArray(parsed)) lastChunkIds = parsed as string[];
      } catch {
        // corrupt/legacy value — treat as none
      }
    }
    return { chunkOffset: row.chunk_offset, lastTrajectoryId: row.last_trajectory_id, lastChunkIds };
  }

  // Advance the cursor and (optionally) record the trajectory that now sits at the
  // cursor position for the next ingest's supersession check. Omitting the last-*
  // args leaves those columns null (they only matter for the ingest pipeline).
  setCursor(sessionId: string, chunkOffset: number, lastTrajectoryId?: string, lastChunkIds?: string[]): void {
    this.db
      .query(
        `INSERT INTO cursor (session_id, chunk_offset, processed_at, last_trajectory_id, last_chunk_ids)
         VALUES (?, ?, datetime('now'), ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           chunk_offset = excluded.chunk_offset,
           processed_at = excluded.processed_at,
           last_trajectory_id = excluded.last_trajectory_id,
           last_chunk_ids = excluded.last_chunk_ids`
      )
      .run(sessionId, chunkOffset, lastTrajectoryId ?? null, lastChunkIds ? JSON.stringify(lastChunkIds) : null);
  }

  // Reindex support: wipe the ingest bookkeeping (cursors + seen hashes) so the
  // next ingest re-chunks and re-embeds every session from the top. Everything
  // else (stats, recents, demand, snapshots) is untouched.
  clearIngestState(): void {
    this.db.exec('DELETE FROM cursor; DELETE FROM seen_hashes;');
  }

  hasSeen(hash: string): boolean {
    const row = this.db.query<{ hash: string }, [string]>('SELECT hash FROM seen_hashes WHERE hash = ?').get(hash);
    return row !== null;
  }

  markSeen(hash: string): void {
    this.db.query('INSERT OR IGNORE INTO seen_hashes (hash) VALUES (?)').run(hash);
  }

  // Retract seen-markers for chunks whose backend rows were deleted (V2
  // supersession). Keeps the seen⇒present invariant: without this, content that
  // reverts to a previously-seen state is hasSeen-skipped after its replacement
  // was deleted, leaving the backend with neither version.
  forgetSeen(hashes: string[]): void {
    if (hashes.length === 0) return;
    const del = this.db.query('DELETE FROM seen_hashes WHERE hash = ?');
    for (const h of hashes) del.run(h);
  }

  setStat(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO stats (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  getStat(key: string): string | null {
    const row = this.db.query<{ value: string }, [string]>('SELECT value FROM stats WHERE key = ?').get(key);
    return row?.value ?? null;
  }

  // --- Trend snapshots -------------------------------------------------------

  // Append a trend snapshot, then trim to the SNAPSHOTS_CAP newest rows of the
  // same kind (each kind keeps its own window, RECENTS_CAP-style).
  addSnapshot(kind: string, payload: object): void {
    this.db.query('INSERT INTO snapshots (kind, payload) VALUES (?, ?)').run(kind, JSON.stringify(payload));
    this.db
      .query(
        `DELETE FROM snapshots WHERE kind = ? AND id NOT IN (
           SELECT id FROM snapshots WHERE kind = ? ORDER BY ts DESC, id DESC LIMIT ?
         )`
      )
      .run(kind, kind, SNAPSHOTS_CAP);
  }

  // Newest first, with payloads parsed back to objects.
  getSnapshots(kind: string, limit = SNAPSHOTS_CAP): SnapshotRow[] {
    return this.db
      .query<{ id: number; ts: string; kind: string; payload: string }, [string, number]>(
        'SELECT id, ts, kind, payload FROM snapshots WHERE kind = ? ORDER BY ts DESC, id DESC LIMIT ?'
      )
      .all(kind, limit)
      .map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  }

  // --- Askeval runs ----------------------------------------------------------

  // Open a 'running' run; returns its id. Trims to the ASKEVAL_CAP newest runs.
  startAskevalRun(): number {
    const res = this.db.query("INSERT INTO askeval_runs (started_at, status) VALUES (datetime('now'), 'running')").run();
    this.db
      .query(
        `DELETE FROM askeval_runs WHERE id NOT IN (
           SELECT id FROM askeval_runs ORDER BY started_at DESC, id DESC LIMIT ?
         )`
      )
      .run(ASKEVAL_CAP);
    return Number(res.lastInsertRowid);
  }

  // Close out a run. summary/reports are stored as JSON blobs (null if omitted).
  finishAskevalRun(id: number, status: string, summary?: unknown, reports?: unknown): void {
    this.db
      .query("UPDATE askeval_runs SET finished_at = datetime('now'), status = ?, summary = ?, reports = ? WHERE id = ?")
      .run(
        status,
        summary === undefined ? null : JSON.stringify(summary),
        reports === undefined ? null : JSON.stringify(reports),
        id
      );
  }

  // Newest first, with summary/reports parsed back to objects (null when unset).
  getAskevalRuns(limit = 20): AskevalRunRow[] {
    return this.db
      .query<
        { id: number; started_at: string; finished_at: string | null; status: string; summary: string | null; reports: string | null },
        [number]
      >(
        'SELECT id, started_at, finished_at, status, summary, reports FROM askeval_runs ORDER BY started_at DESC, id DESC LIMIT ?'
      )
      .all(limit)
      .map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        status: r.status,
        summary: r.summary === null ? null : JSON.parse(r.summary),
        reports: r.reports === null ? null : JSON.parse(r.reports),
      }));
  }

  // --- Context-injection log -------------------------------------------------

  // Record one context-injection fire (including empty fires: repo,0,0,0).
  logContextInjection(repo: string, pages: number, memories: number, estTokens: number): void {
    this.db
      .query('INSERT INTO context_log (repo, pages, memories, est_tokens) VALUES (?, ?, ?, ?)')
      .run(repo, pages, memories, estTokens);
  }

  // Injection activity over the last `days`: total fires + last fire ts, plus a
  // last-7-day count for the recent-activity readout.
  contextStats(days = 30): ContextStats {
    const row = this.db
      .query<{ count: number; lastTs: string | null }, [string]>(
        "SELECT COUNT(*) AS count, MAX(ts) AS lastTs FROM context_log WHERE ts >= datetime('now', ?)"
      )
      .get(`-${days} days`)!;
    const last7d = this.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM context_log WHERE ts >= datetime('now', '-7 days')")
      .get()!.c;
    return { count: row.count, lastTs: row.lastTs, last7d };
  }

  close(): void {
    this.db.close();
  }
}
