import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileTransactionRecord } from '@cloudhelm/core';
import { SqliteStore } from '../../packages/adapters/src/sqlite-store.js';

const roots: string[] = []; const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function database(): string { const root = mkdtempSync(join(tmpdir(), 'file-journal-')); roots.push(root); return join(root, 'journal.sqlite'); }
function open(file: string): SqliteStore { const store = new SqliteStore(file); stores.push(store); return store; }
function record(): FileTransactionRecord { return { id: 'txn', operationId: 'operation', taskId: 'task', hostId: 'host', fingerprint: 'a'.repeat(64), loginAs: 'user', runAs: 'user', stage: 'prepared', revision: 1, updatedAt: 1,
  plan: { version: 1, transactionId: 'txn', before: { path: '/srv/file', exists: false, parent: { device: '1', inode: '2', size: 0, mtimeNs: '3', ctimeNs: '4' } }, contentSize: 3, contentSha256: 'b'.repeat(64),
    metadataPolicy: 'preserve-or-refuse', runtime: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'c'.repeat(64), size: 1 } } }; }
describe('file journal SQLite durability', () => {
  it('migration 12 preserves old unknown operations and applies cache defaults only once', () => {
    const file = database(); const created = open(file); const old = { id: 'old', kind: 'write-file', status: 'unknown', preview: 'legacy' };
    created.put('operations', 'old', old); created.put('hosts', 'host', { id: 'host' }); created.close(); stores.pop();
    const legacy = new Database(file); legacy.exec('DELETE FROM schema_migrations WHERE version=12; DROP INDEX file_transaction_lookup; DROP INDEX runtime_resource_lookup;'); legacy.close();
    const migrated = open(file); expect(migrated.get('operations', 'old')).toEqual(old); expect(migrated.list('file-transactions')).toEqual([]);
    expect(migrated.get('hosts', 'host')).toMatchObject({ sudoCachePolicy: { mode: 'disabled', revision: 1 } });
    migrated.put('hosts', 'host', { id: 'host', sudoCachePolicy: { mode: 'single-password-auto', revision: 2 } }); migrated.close(); stores.pop();
    const reopened = open(file); expect(reopened.get('hosts', 'host')).toMatchObject({ sudoCachePolicy: { mode: 'single-password-auto', revision: 2 } });
    const check = new Database(file); try {
      expect(check.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=12').get()).toEqual({ n: 1 });
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('file_transaction_lookup','runtime_resource_lookup')").all()).toHaveLength(2);
    } finally { check.close(); }
  });
  it('survives reopen and treats an identical lost-ACK retry as idempotent', () => {
    const file = database(); const store = open(file); const first = record(); expect(store.commitFileTransaction(first, null)).toEqual(first);
    store.close(); stores.pop(); const reopened = open(file);
    expect(reopened.commitFileTransaction(first, null)).toEqual(first); expect(reopened.list('file-transactions')).toHaveLength(1);
  });
  it('rejects a stale writer from a second SQLite connection', () => {
    const file = database(); const left = open(file); const right = open(file); const first = record(); left.commitFileTransaction(first, null);
    const staged: FileTransactionRecord = { ...first, revision: 2, stage: 'staged', updatedAt: 2 }; left.commitFileTransaction(staged, 1);
    expect(() => right.commitFileTransaction({ ...first, revision: 2, stage: 'unknown', updatedAt: 3 }, 1)).toThrow('revision');
    expect(right.get('file-transactions', first.id)).toEqual(staged);
  });
  it('rolls back the actual SQLite update when storage fails before acknowledgment', () => {
    const store = open(database()); const first = record(); store.commitFileTransaction(first, null); const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation((bucket, id, value) => { put(bucket, id, value); throw new Error('simulated disk failure'); });
    expect(() => store.commitFileTransaction({ ...first, stage: 'staged', revision: 2 }, 1)).toThrow('disk failure');
    expect(store.get('file-transactions', first.id)).toEqual(first);
  });
  it('never upgrades to confirmed without a bound receipt or changes the reviewed identity', () => {
    const store = open(database()); const first = record(); store.commitFileTransaction(first, null);
    expect(() => store.commitFileTransaction({ ...first, stage: 'confirmed', revision: 2 }, 1)).toThrow('receipt');
    expect(() => store.commitFileTransaction({ ...first, stage: 'staged', revision: 2, runAs: 'root' }, 1)).toThrow('binding');
    const confirmed: FileTransactionRecord = { ...first, stage: 'confirmed', revision: 2, receipt: { transactionId: first.id, fingerprint: first.fingerprint, targetSha256: first.plan.contentSha256, deleted: false } };
    expect(store.commitFileTransaction(confirmed, 1)).toEqual(confirmed);
    expect(() => store.commitFileTransaction({ ...confirmed, stage: 'unknown', revision: 3 }, 2)).toThrow('transition');
  });
});
