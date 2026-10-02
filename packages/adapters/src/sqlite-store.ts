import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const records = sqliteTable('records', {
  bucket: text('bucket').notNull(),
  id: text('id').notNull(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull()
}, (table) => [primaryKey({ columns: [table.bucket, table.id] })]);

/** Versioned migration 0001: durable application records. Secret values are encrypted before insertion. */
const migration0001 = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS records (
  bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, id)
);
CREATE INDEX IF NOT EXISTS records_updated_at ON records(bucket, updated_at);
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch());
`;
const migration0002 = `
CREATE TABLE IF NOT EXISTS terminal_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, terminal_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS terminal_logs_lookup ON terminal_logs(terminal_id, id);
CREATE INDEX IF NOT EXISTS terminal_logs_retention ON terminal_logs(created_at);
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, unixepoch());
`;

const migration0003 = `
UPDATE records SET value = json_set(value, '$.provider',
  coalesce((SELECT json_extract(value, '$.provider') FROM records WHERE bucket = 'settings' AND id = 'model-profile'), 'vercel-ai-gateway'))
WHERE bucket = 'tasks' AND json_extract(value, '$.provider') IS NULL;
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, unixepoch());
`;

export class SqliteStore {
  private readonly raw: Database.Database;
  private readonly db;

  constructor(file: string) {
    this.raw = new Database(file);
    this.raw.pragma('journal_mode = WAL');
    this.raw.exec(migration0001);
    this.raw.exec(migration0002);
    this.raw.exec(migration0003);
    this.db = drizzle(this.raw);
  }

  get<T>(bucket: string, id: string): T | undefined {
    const row = this.db.select({ value: records.value }).from(records)
      .where(and(eq(records.bucket, bucket), eq(records.id, id))).get();
    return row ? JSON.parse(row.value) as T : undefined;
  }

  list<T>(bucket: string): T[] {
    return this.db.select({ value: records.value }).from(records).where(eq(records.bucket, bucket)).all()
      .map((row) => JSON.parse(row.value) as T);
  }

  put(bucket: string, id: string, value: unknown): void {
    this.db.insert(records).values({ bucket, id, value: JSON.stringify(value), updatedAt: Date.now() })
      .onConflictDoUpdate({ target: [records.bucket, records.id], set: { value: JSON.stringify(value), updatedAt: Date.now() } }).run();
  }

  remove(bucket: string, id: string): void {
    this.db.delete(records).where(and(eq(records.bucket, bucket), eq(records.id, id))).run();
  }

  appendLog(terminalId: string, data: string): void {
    const insert = this.raw.prepare('INSERT INTO terminal_logs(terminal_id, created_at, bytes, data) VALUES (?, ?, ?, ?)');
    for (let offset = 0; offset < data.length; offset += 8192) {
      const chunk = data.slice(offset, offset + 8192);
      insert.run(terminalId, Date.now(), Buffer.byteLength(chunk), chunk);
    }
  }

  readLog(terminalId: string, maxBytes = 1_000_000): string {
    const rows = this.raw.prepare('SELECT data, bytes FROM terminal_logs WHERE terminal_id = ? ORDER BY id DESC LIMIT 1000')
      .all(terminalId) as Array<{ data: string; bytes: number }>;
    let size = 0;
    const selected: string[] = [];
    for (const row of rows) {
      if (size >= maxBytes) break;
      selected.push(row.data);
      size += row.bytes;
    }
    return selected.reverse().join('').slice(-maxBytes);
  }

  readLogPage(terminalId: string, cursor = 0): { text: string; nextCursor: number; more: boolean } {
    const rows = this.raw.prepare('SELECT id, data FROM terminal_logs WHERE terminal_id = ? AND id > ? ORDER BY id LIMIT 5')
      .all(terminalId, cursor) as Array<{ id: number; data: string }>;
    const page = rows.slice(0, 4);
    return { text: page.map((row) => row.data).join(''), nextCursor: page.at(-1)?.id ?? cursor, more: rows.length > 4 };
  }

  cleanupLogs(maxAgeMs = 30 * 24 * 60 * 60_000, maxBytes = 5 * 1024 ** 3): void {
    this.raw.prepare('DELETE FROM terminal_logs WHERE created_at < ?').run(Date.now() - maxAgeMs);
    let size = (this.raw.prepare('SELECT coalesce(sum(bytes), 0) AS size FROM terminal_logs').get() as { size: number }).size;
    const drop = this.raw.prepare('DELETE FROM terminal_logs WHERE id IN (SELECT id FROM terminal_logs ORDER BY id LIMIT 1000)');
    while (size > maxBytes) {
      const changed = drop.run().changes;
      if (!changed) break;
      size = (this.raw.prepare('SELECT coalesce(sum(bytes), 0) AS size FROM terminal_logs').get() as { size: number }).size;
    }
  }

  close(): void { this.raw.close(); }
}
