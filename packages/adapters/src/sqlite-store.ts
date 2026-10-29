import type { FileTransactionRecord } from '@cloudhelm/core';
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

export interface DataRepair {
  name: string;
  version: number;
  recordIds: string[];
  /** Full read sets detect inserted/deleted rows as well as changed values. */
  baselines: Array<{ bucket: string; values: unknown[] }>;
  changes: Array<{ bucket: string; id: string; value: unknown }>;
}

/** No prompt, credentials, output or request body belongs in a budget receipt. */
export interface RequestBudgetCommit {
  records: Array<{ bucket: string; id: string; before: unknown; value: unknown }>;
  receipt: { owner: string; requestId: string; binding: string; before?: unknown; value: unknown };
}

export class SqliteStore {
  private readonly raw: Database.Database;
  private readonly db;

  constructor(file: string) {
    this.raw = new Database(file);
    try {
      this.migrate();
      this.db = drizzle(this.raw);
    } catch (error) { this.raw.close(); throw error; }
  }

  private migrate(): void {
    this.raw.pragma('journal_mode = WAL');
    this.raw.exec(migration0001);
    this.raw.exec(migration0002);
    this.raw.exec(migration0003);
    // Run destructive compatibility cleanup exactly once, atomically with its version marker.
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 4').get()) return;
      this.raw.exec(`
        DELETE FROM records WHERE bucket IN ('messages', 'model-requests', 'clarifications');
        UPDATE records SET value = json_remove(json_set(value, '$.status',
          CASE WHEN json_extract(value, '$.status') IN ('accepted', 'ready-for-review')
          THEN json_extract(value, '$.status') ELSE 'paused' END), '$.session') WHERE bucket = 'tasks';
        INSERT INTO schema_migrations(version, applied_at) VALUES (4, unixepoch());
      `);
    })();
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 5').get()) return;
      this.raw.exec(`
        CREATE TABLE IF NOT EXISTS content_references (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_migrations(version, applied_at) VALUES (5, unixepoch());
      `);
    })();
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 6').get()) return;
      this.raw.exec(`
        UPDATE records SET value = json_set(value,
          '$.protectedReadPaths', json(coalesce(json_extract(value, '$.protectedReadPaths'), json_extract(value, '$.protectedPaths'), '[]')),
          '$.protectedWritePaths', json(coalesce(json_extract(value, '$.protectedWritePaths'), json_extract(value, '$.protectedPaths'), '[]')))
        WHERE bucket = 'hosts';
        UPDATE records SET value = json_set(value,
          '$.reviewModesByHost', json(coalesce(json_extract(value, '$.reviewModesByHost'),
            (SELECT json_group_object(ids.value, coalesce(json_extract(host.value, '$.defaultMode'), 'ask'))
             FROM json_each(records.value, '$.hostIds') AS ids
             LEFT JOIN records AS host ON host.bucket = 'hosts' AND host.id = ids.value), '{}')),
          '$.reviewRevision', coalesce(json_extract(value, '$.reviewRevision'), 1))
        WHERE bucket = 'tasks';
        INSERT INTO schema_migrations(version, applied_at) VALUES (6, unixepoch());
      `);
    })();
    const migrateLegacyQueries = this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 7').get()) return;
      // Legacy records did not persist the read-only capability. Only exact,
      // trivially safe historical previews can be recovered without the source command.
      this.raw.exec(`
        UPDATE records SET value = json_set(value, '$.readOnly', json('true'))
        WHERE bucket = 'operations' AND json_extract(value, '$.kind') = 'command'
          AND json_extract(value, '$.status') = 'unknown'
          AND json_extract(value, '$.readOnly') IS NULL
          AND json_extract(value, '$.preview') IN ('df -h', 'df -hT', 'docker ps', 'docker ps -a');
        INSERT INTO schema_migrations(version, applied_at) VALUES (7, unixepoch());
      `);
    });
    const migrateLegacyCompletion = this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 8').get()) return;
      this.raw.exec(`
        UPDATE records SET value = json_remove(json_set(value, '$.status', 'answered'), '$.resumeReason')
        WHERE bucket = 'tasks' AND json_extract(value, '$.status') IN ('ready-for-review', 'accepted')
          AND NOT EXISTS (SELECT 1 FROM records AS op WHERE op.bucket = 'operations'
            AND json_extract(op.value, '$.taskId') = records.id
            AND coalesce(json_extract(op.value, '$.readOnly'), 0) != 1
            AND (json_extract(op.value, '$.status') IN ('unknown', 'running', 'proposed', 'approved')
              OR (json_extract(op.value, '$.status') = 'failed'
                AND coalesce(json_extract(op.value, '$.effects'), 'possible') != 'none'
                AND json_extract(op.value, '$.reconciledAt') IS NULL)));
        UPDATE records SET value = json_set(value, '$.status', 'paused', '$.resumeReason', 'verify')
        WHERE bucket = 'tasks' AND json_extract(value, '$.status') IN ('ready-for-review', 'accepted');
        UPDATE records SET value = json_remove(json_set(value, '$.status', 'answered'), '$.resumeReason')
        WHERE bucket = 'tasks' AND json_extract(value, '$.status') = 'paused'
          AND json_extract(value, '$.summary') = '已执行操作，但验证证据尚不完整。请继续核验后验收。'
          AND EXISTS (SELECT 1 FROM records AS op WHERE op.bucket = 'operations'
            AND json_extract(op.value, '$.taskId') = records.id)
          AND NOT EXISTS (SELECT 1 FROM records AS op WHERE op.bucket = 'operations'
            AND json_extract(op.value, '$.taskId') = records.id
            AND (coalesce(json_extract(op.value, '$.readOnly'), 0) != 1
              OR json_extract(op.value, '$.status') NOT IN ('succeeded', 'failed')
              OR json_type(op.value, '$.interruption') IS NOT NULL))
          AND EXISTS (SELECT 1 FROM records AS msg WHERE msg.bucket = 'messages'
            AND json_extract(msg.value, '$.taskId') = records.id
            AND json_extract(msg.value, '$.role') = 'agent'
            AND length(trim(coalesce(json_extract(msg.value, '$.text'), ''))) > 0
            AND json_extract(msg.value, '$.createdAt') >= coalesce((SELECT max(json_extract(prior.value, '$.createdAt'))
              FROM records AS prior WHERE prior.bucket = 'messages' AND json_extract(prior.value, '$.taskId') = records.id
                AND json_extract(prior.value, '$.role') = 'user'), 0));
        INSERT INTO schema_migrations(version, applied_at) VALUES (8, unixepoch());
      `);
    });
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 9').get()) return;
      // Keep published migration SQL unchanged, but prevent its legacy heuristics
      // from granting capabilities or inferring completion during a new upgrade.
      // All three versions commit together: a crash cannot lose these preimages.
      const unknown = this.raw.prepare("SELECT id,value FROM records WHERE bucket = 'operations' AND json_extract(value, '$.status') = 'unknown'")
        .all() as Array<{ id: string; value: string }>;
      const stopped = this.raw.prepare("SELECT id,value FROM records WHERE bucket = 'tasks' AND json_extract(value, '$.status') IN ('paused','failed')")
        .all() as Array<{ id: string; value: string }>;
      const restore = this.raw.prepare('UPDATE records SET value = ? WHERE bucket = ? AND id = ?');
      migrateLegacyQueries();
      for (const row of unknown) restore.run(row.value, 'operations', row.id);
      migrateLegacyCompletion();
      // Schema readiness is distinct from per-record repair completion. Parser
      // failures must not mark the entire data migration finished.
      this.raw.exec(`
        CREATE TABLE data_repairs (
          name TEXT NOT NULL, version INTEGER NOT NULL, record_id TEXT NOT NULL, applied_at INTEGER NOT NULL,
          PRIMARY KEY (name, version, record_id)
        );
        INSERT INTO schema_migrations(version, applied_at) VALUES (9, unixepoch());
      `);
      for (const row of stopped) restore.run(row.value, 'tasks', row.id);
    }).immediate();
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 10').get()) return;
      this.raw.exec(`
        CREATE TABLE request_budget_receipts (
          owner TEXT NOT NULL, request_id TEXT NOT NULL, binding TEXT NOT NULL, value TEXT NOT NULL,
          updated_at INTEGER NOT NULL, PRIMARY KEY(owner, request_id)
        );
        INSERT INTO schema_migrations(version, applied_at) VALUES (10, unixepoch());
      `);
    }).immediate();
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 11').get()) return;
      // Preserve old reports verbatim. Never upgrade their assertions into deterministic evidence.
      this.raw.exec(`
        INSERT OR IGNORE INTO records(bucket, id, value, updated_at)
        SELECT 'verification-reports', id || ':legacy-v11',
          json_object('taskId', id, 'report', json_extract(value, '$.report')), updated_at
        FROM records WHERE bucket = 'tasks' AND json_type(value, '$.report') = 'object';
        INSERT INTO schema_migrations(version, applied_at) VALUES (11, unixepoch());
      `);
    }).immediate();
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 12').get()) return;
      this.raw.exec(`
        CREATE INDEX IF NOT EXISTS file_transaction_lookup ON records(json_extract(value, '$.hostId'), json_extract(value, '$.stage')) WHERE bucket = 'file-transactions';
        CREATE INDEX IF NOT EXISTS runtime_resource_lookup ON records(json_extract(value, '$.taskId')) WHERE bucket = 'runtime-resources';
        UPDATE records SET value = json_set(value, '$.sudoCachePolicy', json('{"mode":"disabled","revision":1}')) WHERE bucket = 'hosts';
        INSERT INTO schema_migrations(version, applied_at) VALUES (12, unixepoch());
      `);
    }).immediate();
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

  /** Compare the whole read set and atomically commit records plus version receipts.
   * Analysis is done before this synchronous transaction, never inside it. */
  commitDataRepair(repair: DataRepair): void {
    this.raw.transaction(() => {
      for (const { bucket, values } of repair.baselines) {
        if (JSON.stringify(this.list(bucket)) !== JSON.stringify(values)) {
          throw new Error('Historical repair source changed; retry from a fresh snapshot');
        }
      }
      for (const { bucket, id, value } of repair.changes) this.put(bucket, id, value);
      const receipt = this.raw.prepare('INSERT INTO data_repairs(name,version,record_id,applied_at) VALUES(?,?,?,?)');
      for (const id of repair.recordIds) receipt.run(repair.name, repair.version, id, Date.now());
    }).immediate();
  }

  /** Durable CAS: only return after SQLite commits; duplicate ACK recovery is idempotent. */
  commitFileTransaction(record: FileTransactionRecord, expectedRevision: number | null): FileTransactionRecord {
    return this.raw.transaction(() => {
      const prior = this.get<FileTransactionRecord>('file-transactions', record.id);
      if (prior && JSON.stringify(prior) === JSON.stringify(record)) return prior;
      if ((expectedRevision === null ? !!prior : prior?.revision !== expectedRevision)
        || record.revision !== (expectedRevision ?? 0) + 1) throw new Error('File transaction revision conflict');
      if (record.id !== record.plan.transactionId || (prior && (prior.fingerprint !== record.fingerprint
        || prior.operationId !== record.operationId || prior.taskId !== record.taskId || prior.hostId !== record.hostId
        || prior.loginAs !== record.loginAs || prior.runAs !== record.runAs
        || JSON.stringify(prior.plan) !== JSON.stringify(record.plan)))) throw new Error('File transaction binding changed');
      const transitions: Record<string, string[]> = { prepared: ['staged', 'confirmed', 'conflict', 'unknown'],
        staged: ['committed', 'confirmed', 'conflict', 'unknown'], committed: ['confirmed', 'unknown'],
        unknown: ['unknown', 'confirmed', 'conflict'], confirmed: [], conflict: [] };
      if (prior && !transitions[prior.stage]?.includes(record.stage)) throw new Error('Invalid file transaction transition');
      if (!prior && record.stage !== 'prepared') throw new Error('File transaction must begin with durable intent');
      if (record.receipt && (record.receipt.transactionId !== record.id || record.receipt.fingerprint !== record.fingerprint)) throw new Error('Receipt binding changed');
      if (['committed', 'confirmed'].includes(record.stage) && (!record.receipt
        || record.receipt.targetSha256 !== record.plan.contentSha256 || record.receipt.deleted !== (record.plan.contentSha256 === undefined))) throw new Error('Confirmed transaction requires its bound receipt');
      this.put('file-transactions', record.id, record);
      return record;
    }).immediate();
  }

  requestBudgetReceipt<T>(owner: string, requestId: string): { binding: string; value: T } | undefined {
    const row = this.raw.prepare('SELECT binding,value FROM request_budget_receipts WHERE owner = ? AND request_id = ?')
      .get(owner, requestId) as { binding: string; value: string } | undefined;
    return row ? { binding: row.binding, value: JSON.parse(row.value) as T } : undefined;
  }

  /** Acknowledgment is safe only after this immediate transaction has committed.
   * Receipt collisions, stale records and partial writes all roll back together. */
  commitRequestBudget(change: RequestBudgetCommit): void {
    this.raw.transaction(() => {
      const receipt = change.receipt;
      const previous = this.requestBudgetReceipt(receipt.owner, receipt.requestId);
      if (receipt.before === undefined ? previous !== undefined
        : !previous || previous.binding !== receipt.binding || JSON.stringify(previous.value) !== JSON.stringify(receipt.before)) {
        throw new Error('Budget receipt changed; reload authoritative state');
      }
      for (const record of change.records) {
        if (JSON.stringify(this.get(record.bucket, record.id)) !== JSON.stringify(record.before)) {
          throw new Error('Budget source changed; reload authoritative state');
        }
      }
      for (const record of change.records) this.put(record.bucket, record.id, record.value);
      this.raw.prepare(`INSERT INTO request_budget_receipts(owner,request_id,binding,value,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(owner,request_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
        .run(receipt.owner, receipt.requestId, receipt.binding, JSON.stringify(receipt.value), Date.now());
    }).immediate();
  }

  remove(bucket: string, id: string): void {
    this.db.delete(records).where(and(eq(records.bucket, bucket), eq(records.id, id))).run();
  }

  /** Removes records whose JSON field matches a value (conversation cleanup). */
  removeWhere(bucket: string, field: string, value: string): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(field)) throw new Error('Invalid record field');
    this.raw.prepare(`DELETE FROM records WHERE bucket = ? AND json_extract(value, '$.${field}') = ?`).run(bucket, value);
  }

  /** Removes records whose id starts with a literal prefix. */
  removePrefix(bucket: string, idPrefix: string): void {
    const escaped = idPrefix.replace(/[\\%_]/gu, (char) => `\\${char}`);
    this.raw.prepare("DELETE FROM records WHERE bucket = ? AND id LIKE ? ESCAPE '\\'").run(bucket, `${escaped}%`);
  }

  removeLogs(terminalId: string): void {
    this.raw.prepare('DELETE FROM terminal_logs WHERE terminal_id = ?').run(terminalId);
  }

  appendLog(terminalId: string, data: string): void {
    const insert = this.raw.prepare('INSERT INTO terminal_logs(terminal_id, created_at, bytes, data) VALUES (?, ?, ?, ?)');
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(data.length, offset + 8192);
      if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff
        && data.charCodeAt(end) >= 0xdc00 && data.charCodeAt(end) <= 0xdfff) end--;
      const chunk = data.slice(offset, end);
      insert.run(terminalId, Date.now(), Buffer.byteLength(chunk), chunk);
      offset = end;
    }
  }

  putReference(id: string, value: unknown): void {
    this.raw.prepare('INSERT OR REPLACE INTO content_references(id, value) VALUES (?, ?)').run(id, JSON.stringify(value));
  }
  readReference<T>(id: string): T | undefined {
    const row = this.raw.prepare('SELECT value FROM content_references WHERE id = ?').get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  removeReference(id: string): void { this.raw.prepare('DELETE FROM content_references WHERE id = ?').run(id); }
  readCompleteLog(id: string, expectedLength: number): string {
    const rows = this.raw.prepare('SELECT data FROM terminal_logs WHERE terminal_id = ? ORDER BY id').all(id) as { data: string }[];
    const value = rows.map((row) => row.data).join('');
    if (value.length !== expectedLength) throw new Error('命令日志已不完整，请手动选择引用内容');
    return value;
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
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid log cursor');
    // BLOB slicing bounds bytes without SQLite TEXT substr dropping NUL suffixes.
    // Oversized/corrupt rows are rejected, never partially consumed. Keep BOMs
    // as log data; decode only complete rows that fit the page budget.
    const rows = this.raw.prepare('SELECT id, substr(CAST(data AS BLOB), 1, 49153) AS data FROM terminal_logs WHERE terminal_id = ? AND id > ? ORDER BY id LIMIT 5')
      .all(terminalId, cursor) as Array<{ id: number; data: Buffer }>;
    const page: Array<{ id: number; data: string }> = [];
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let bytes = 0;
    for (const row of rows.slice(0, 4)) {
      const size = row.data.length;
      if (bytes + size > 48 * 1024) {
        if (!page.length) throw new Error('Log chunk exceeds the bounded page; no cursor consumed');
        break;
      }
      bytes += size; page.push({ id: row.id, data: decoder.decode(row.data) });
    }
    return { text: page.map((row) => row.data).join(''), nextCursor: page.at(-1)?.id ?? cursor, more: rows.length > page.length };
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
