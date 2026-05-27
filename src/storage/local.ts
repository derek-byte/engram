import { Database } from 'bun:sqlite';
import { LOCAL_DB_PATH, ensureEngramDir } from '../config/index.ts';

export interface CursorRow {
  sessionId: string;
  chunkOffset: number;
  processedAt: string;
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
    `);
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
