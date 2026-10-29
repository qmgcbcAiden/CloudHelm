import { describe, expect, it, vi } from 'vitest';
import type { FileTransactionRecord } from '@cloudhelm/core';
import type { FileJournalRequest } from '@cloudhelm/contracts';
import { FileTransactionClient } from '../../../apps/desktop/src/worker/file-transaction-client.js';
import { createFileJournalHandler } from '../../../apps/desktop/src/main/file-transaction-broker.js';

function record(): FileTransactionRecord { return { id: 'txn', operationId: 'operation', taskId: 'task', hostId: 'host', fingerprint: 'a'.repeat(64), loginAs: 'user', runAs: 'user',
  plan: { version: 1, transactionId: 'txn', before: { path: '/srv/file', exists: false, parent: { device: '1', inode: '2', size: 0, mtimeNs: '3', ctimeNs: '4' } }, contentSize: 0, contentSha256: 'b'.repeat(64),
    metadataPolicy: 'preserve-or-refuse', runtime: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'c'.repeat(64), size: 1 } }, stage: 'prepared', revision: 1, updatedAt: 1 }; }
describe('durable file journal boundary', () => {
  it('does not treat dispatch as durable acknowledgment', async () => {
    let sent!: FileJournalRequest; const client = new FileTransactionClient((value) => { sent = value; }); let done = false;
    const pending = client.commit(record(), null).then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    client.resolve({ id: sent.fileJournalRequest.id, record: record() }); await pending; expect(done).toBe(true); client.close();
  });
  it('rejects changed acknowledgment binding and ignores a later duplicate', async () => {
    let sent!: FileJournalRequest; const client = new FileTransactionClient((value) => { sent = value; });
    const pending = client.commit(record(), null); const rejection = expect(pending).rejects.toThrow('binding');
    client.resolve({ id: sent.fileJournalRequest.id, record: { ...record(), hostId: 'other' } }); await rejection;
    client.resolve({ id: sent.fileJournalRequest.id, record: record() }); client.close();
  });
  it('drops late replies after cancellation without undoing a durable record', async () => {
    let sent!: FileJournalRequest; const client = new FileTransactionClient((value) => { sent = value; }); const controller = new AbortController();
    const pending = client.commit(record(), null, controller.signal); const rejection = expect(pending).rejects.toThrow('canceled');
    controller.abort(); await rejection; client.resolve({ id: sent.fileJournalRequest.id, record: record() }); client.close();
  });
  it('validates schema and immutable operation binding before storage', () => {
    const previous = record(); const store = { get: vi.fn(() => previous), commitFileTransaction: vi.fn((value: FileTransactionRecord) => value) };
    const handler = createFileJournalHandler(store as any, () => {});
    expect(handler({ kind: 'commit', record: { ...previous, content: 'must not persist' }, expectedRevision: null })).toEqual({ error: 'journal-invalid' });
    expect(handler({ kind: 'commit', record: { ...previous, hostId: 'other', revision: 2 }, expectedRevision: 1 })).toEqual({ error: 'journal-conflict' });
    expect(store.commitFileTransaction).not.toHaveBeenCalled();
  });
  it('fails closed when Main cannot authorize the task', () => {
    const store = { get: vi.fn(), commitFileTransaction: vi.fn() }; const handler = createFileJournalHandler(store, () => { throw new Error('no task'); });
    expect(handler({ kind: 'get', id: 'txn' })).toEqual({ error: 'journal-unavailable' }); expect(store.get).not.toHaveBeenCalled();
  });
});
