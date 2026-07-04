import { Database } from 'bun:sqlite';
import { LOCAL_DB_PATH, ensureEngramDir } from '../config/index.ts';

export interface CursorRow {
  sessionId: string;
  chunkOffset: number;
  processedAt: string;
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

export class LocalStore {
  private db: Database;

  constructor(path: string = LOCAL_DB_PATH) {
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
        processed_at TEXT NOT NULL
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
    `);
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

  getCursor(sessionId: string): number {
    const row = this.db
      .query<{ chunk_offset: number }, [string]>('SELECT chunk_offset FROM cursor WHERE session_id = ?')
      .get(sessionId);
    return row?.chunk_offset ?? 0;
  }

  setCursor(sessionId: string, chunkOffset: number): void {
    this.db
      .query(
        `INSERT INTO cursor (session_id, chunk_offset, processed_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(session_id) DO UPDATE SET
           chunk_offset = excluded.chunk_offset,
           processed_at = excluded.processed_at`
      )
      .run(sessionId, chunkOffset);
  }

  hasSeen(hash: string): boolean {
    const row = this.db.query<{ hash: string }, [string]>('SELECT hash FROM seen_hashes WHERE hash = ?').get(hash);
    return row !== null;
  }

  markSeen(hash: string): void {
    this.db.query('INSERT OR IGNORE INTO seen_hashes (hash) VALUES (?)').run(hash);
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

  close(): void {
    this.db.close();
  }
}
