import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../packages/adapters/src/sqlite-store.js';

const stores: SqliteStore[] = [];
const tempDirs: string[] = [];
function open(): SqliteStore {
  const store = new SqliteStore(':memory:');
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('migrates old host protection and captures each existing conversation effective review mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-policy-'));
  tempDirs.push(directory);
  const file = join(directory, 'records.sqlite');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(bucket, id));
    INSERT INTO schema_migrations VALUES(4, 1), (5, 1);`);
  const put = legacy.prepare('INSERT INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)');
  put.run('hosts', 'old', JSON.stringify({ id: 'old', defaultMode: 'permissive', protectedPaths: ['/srv/secret'] }));
  put.run('tasks', 'task', JSON.stringify({ id: 'task', hostIds: ['old'] }));
  legacy.close();
  const migrated = new SqliteStore(file);
  stores.push(migrated);
  expect(migrated.get('hosts', 'old')).toMatchObject({ protectedReadPaths: ['/srv/secret'],
    protectedWritePaths: ['/srv/secret'] });
  expect(migrated.get('tasks', 'task')).toMatchObject({ reviewModesByHost: { old: 'permissive' }, reviewRevision: 1 });
  migrated.close(); stores.pop();
  const reopened = new SqliteStore(file);
  stores.push(reopened);
  expect(reopened.get('tasks', 'task')).toMatchObject({ reviewModesByHost: { old: 'permissive' } });
});

it('preserves unknown legacy outcomes instead of granting capabilities from previews during upgrade', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-read-only-'));
  tempDirs.push(directory);
  const file = join(directory, 'records.sqlite');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(bucket, id));
    INSERT INTO schema_migrations VALUES(4, 1), (5, 1), (6, 1);`);
  const put = legacy.prepare('INSERT INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)');
  put.run('operations', 'query', JSON.stringify({ kind: 'command', status: 'unknown', preview: 'df -h' }));
  put.run('operations', 'unsafe', JSON.stringify({ kind: 'command', status: 'unknown', preview: 'df -h && rm /tmp/data' }));
  put.run('operations', 'other', JSON.stringify({ kind: 'command', status: 'unknown', preview: 'docker ps --format "{{.Names}}"' }));
  legacy.close();
  const migrated = new SqliteStore(file);
  stores.push(migrated);
  expect(migrated.get<{ readOnly?: boolean }>('operations', 'query')?.readOnly).toBeUndefined();
  expect(migrated.get<{ readOnly?: boolean }>('operations', 'unsafe')?.readOnly).toBeUndefined();
  expect(migrated.get<{ readOnly?: boolean }>('operations', 'other')?.readOnly).toBeUndefined();
});

it('migrates completed legacy reviews without inferring completion from old assistant text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-completion-'));
  tempDirs.push(directory);
  const file = join(directory, 'records.sqlite');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(bucket, id));
    INSERT INTO schema_migrations VALUES(4, 1), (5, 1), (6, 1), (7, 1);`);
  const put = legacy.prepare('INSERT INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)');
  for (const status of ['ready-for-review', 'accepted']) put.run('tasks', status, JSON.stringify({ status, report: { summary: '已验证' } }));
  put.run('tasks', 'legacy-unsafe', JSON.stringify({ status: 'accepted' }));
  put.run('operations', 'legacy-unsafe', JSON.stringify({ taskId: 'legacy-unsafe', readOnly: false, status: 'unknown' }));
  const summary = '已执行操作，但验证证据尚不完整。请继续核验后验收。';
  for (const id of ['read', 'unknown', 'interrupted', 'unanswered']) {
    put.run('tasks', id, JSON.stringify({ status: 'paused', summary, resumeReason: 'interrupted' }));
    put.run('operations', id, JSON.stringify({ taskId: id, readOnly: id !== 'unknown', status: 'succeeded',
      ...(id === 'interrupted' ? { interruption: { source: 'stop-button' } } : {}) }));
    if (id !== 'unanswered') put.run('messages', id, JSON.stringify({ taskId: id, role: 'agent', text: '查询完成', createdAt: 10 }));
  }
  legacy.close();
  const migrated = new SqliteStore(file);
  stores.push(migrated);
  for (const id of ['ready-for-review', 'accepted']) expect(migrated.get<{ status: string; report: { summary: string } }>('tasks', id))
    .toMatchObject({ status: 'answered', report: { summary: '已验证' } });
  expect(migrated.get<{ status: string; resumeReason?: string }>('tasks', 'legacy-unsafe'))
    .toMatchObject({ status: 'paused', resumeReason: 'verify' });
  expect(migrated.get('tasks', 'read')).toMatchObject({ status: 'paused', resumeReason: 'interrupted', summary });
  for (const id of ['unknown', 'interrupted', 'unanswered']) expect(migrated.get<{ status: string }>('tasks', id)?.status).toBe('paused');
  migrated.close(); stores.pop();
  const reopened = new SqliteStore(file);
  stores.push(reopened);
  expect(reopened.get('tasks', 'read')).toMatchObject({ status: 'paused', resumeReason: 'interrupted', summary });
});

it('adds migration 9 without declaring unexamined historical records repaired', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-repair-schema-'));
  tempDirs.push(directory);
  const file = join(directory, 'records.sqlite');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(bucket, id));
    INSERT INTO schema_migrations VALUES(4,1),(5,1),(6,1),(7,1),(8,1);`);
  const original = { id: 'unknown', kind: 'command', status: 'unknown', preview: 'docker images' };
  legacy.prepare('INSERT INTO records VALUES(?,?,?,1)').run('operations', 'unknown', JSON.stringify(original));
  legacy.close();
  const store = new SqliteStore(file);
  stores.push(store);
  expect(store.get('operations', 'unknown')).toEqual(original);
  const inspection = new Database(file);
  try {
    expect(inspection.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 12 });
    expect(inspection.prepare('SELECT * FROM data_repairs').all()).toEqual([]);
  } finally { inspection.close(); }
});

it('commits repair receipts atomically and rejects changed or expanded read sets', () => {
  const store = open();
  store.put('operations', 'op', { readOnly: false });
  store.put('tasks', 'task', { pending: true });
  const repair = { name: 'fixture-query', version: 1, recordIds: ['op'],
    baselines: ['operations', 'tasks'].map((bucket) => ({ bucket, values: store.list(bucket) })),
    changes: [{ bucket: 'operations', id: 'op', value: { readOnly: true } },
      { bucket: 'tasks', id: 'task', value: { pending: false } }] };
  const put = store.put.bind(store);
  const fail = vi.spyOn(store, 'put').mockImplementation((bucket, id, value) => {
    if (bucket === 'tasks') throw new Error('disk failure');
    put(bucket, id, value);
  });
  expect(() => store.commitDataRepair(repair)).toThrow('disk failure');
  expect(store.get('operations', 'op')).toEqual({ readOnly: false });
  expect(store.get('tasks', 'task')).toEqual({ pending: true });
  fail.mockRestore();
  store.put('operations', 'foreign', { status: 'unknown' });
  expect(() => store.commitDataRepair(repair)).toThrow('source changed');
  store.remove('operations', 'foreign');
  store.commitDataRepair(repair); // The failed transaction did not consume its receipt.
  expect(store.get('operations', 'op')).toEqual({ readOnly: true });
  expect(store.get('tasks', 'task')).toEqual({ pending: false });
  expect(() => store.commitDataRepair({ ...repair,
    baselines: repair.baselines.map(({ bucket }) => ({ bucket, values: store.list(bucket) })),
    changes: [{ bucket: 'operations', id: 'op', value: { readOnly: false } }]
  })).toThrow(/UNIQUE/u);
  expect(store.get('operations', 'op')).toEqual({ readOnly: true });
});

describe('record cleanup for deleted conversations', () => {
  it('removes records by JSON field and keeps other conversations', () => {
    const store = open();
    store.put('messages', 'm1', { taskId: 'a', text: 'hello' });
    store.put('messages', 'm2', { taskId: 'b', text: 'kept' });
    store.put('operations', 'o1', { taskId: 'a', preview: 'rm' });
    store.removeWhere('messages', 'taskId', 'a');
    expect(store.list('messages')).toEqual([{ taskId: 'b', text: 'kept' }]);
    expect(store.list('operations')).toHaveLength(1);
  });

  it('removes records by literal prefix without matching wildcard characters', () => {
    const store = open();
    store.put('model-requests', 'a:1', { taskId: 'a' });
    store.put('model-requests', 'a:2', { taskId: 'a' });
    store.put('model-requests', 'ab:1', { taskId: 'ab' });
    store.put('model-requests', 'a_1', { taskId: 'a' });
    store.removePrefix('model-requests', 'a:');
    expect(store.list('model-requests').map((item) => (item as { taskId: string }).taskId).sort()).toEqual(['a', 'ab']);
  });

  it('removes terminal logs of one session only', () => {
    const store = open();
    store.appendLog('t1', 'first');
    store.appendLog('t2', 'other');
    store.removeLogs('t1');
    expect(store.readLog('t1')).toBe('');
    expect(store.readLog('t2')).toBe('other');
  });

  it('rejects unsafe field names', () => {
    const store = open();
    expect(() => store.removeWhere('messages', "taskId') OR 1=1 --", 'a')).toThrow();
    expect(() => store.removeWhere('messages', 'task-id', 'a')).toThrow();
  });
});
