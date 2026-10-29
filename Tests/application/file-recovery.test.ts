import { describe, expect, it, vi } from 'vitest';
import type { FileTransactionRecord } from '@cloudhelm/core';
import type { FileRemotePort, ManagedFileOperation } from '../../packages/application/src/file-transactions.js';
import { recoverFileTransaction } from '../../packages/application/src/file-recovery.js';

function fixture() {
  const record: FileTransactionRecord = { id: 'txn', operationId: 'operation', taskId: 'task', hostId: 'host', fingerprint: 'a'.repeat(64), loginAs: 'user', runAs: 'user', stage: 'unknown', revision: 2, updatedAt: 1,
    plan: { version: 1, transactionId: 'txn', before: { path: '/srv/file', exists: false, parent: { device: '1', inode: '2', size: 0, mtimeNs: '3', ctimeNs: '4' } }, contentSha256: 'b'.repeat(64), contentSize: 3,
      metadataPolicy: 'preserve-or-refuse', runtime: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'c'.repeat(64), size: 1 } } };
  const operation: ManagedFileOperation = { id: 'operation', kind: 'write-file', path: '/srv/file', content: '', filePlan: record.plan,
    scope: { taskId: 'task', hostId: 'host', runAs: 'user', cwd: '/srv', terminalId: 'new-terminal', terminalGeneration: 2, policyRevision: 1, allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'recover' } };
  const journal = { get: vi.fn(async () => record), commit: vi.fn(async (next: FileTransactionRecord) => next) };
  const snapshot = { ...record.plan.before, exists: true, sha256: record.plan.contentSha256 };
  const receipt = { transactionId: 'txn', fingerprint: record.fingerprint, targetSha256: record.plan.contentSha256, deleted: false };
  const remote = { artifact: record.plan.runtime, inspect: vi.fn(), apply: vi.fn(), cleanup: vi.fn(), recover: vi.fn() } satisfies FileRemotePort;
  return { record, operation, journal, snapshot, receipt, remote };
}
describe('read-only file recovery', () => {
  it('requires receipt plus current state and durable acknowledgment before resolving', async () => {
    const f = fixture(); f.remote.recover.mockResolvedValue({ status: 'succeeded', effects: 'possible', stage: 'confirmed', snapshot: f.snapshot, receipt: f.receipt });
    const result = await recoverFileTransaction(f.record, f.operation, f.remote, f.journal);
    expect(result.resolved).toBe(true); expect(result.view.evidence).toBe('receipt-confirmed'); expect(f.journal.commit).toHaveBeenCalledOnce();
    expect(f.remote.apply).not.toHaveBeenCalled(); expect(f.remote.cleanup).not.toHaveBeenCalled();
  });
  it('does not turn matching content without a receipt into execution proof', async () => {
    const f = fixture(); f.remote.recover.mockResolvedValue({ status: 'unknown', effects: 'possible', snapshot: f.snapshot, code: 'matches-without-receipt' });
    const result = await recoverFileTransaction(f.record, f.operation, f.remote, f.journal);
    expect(result.resolved).toBe(false); expect(result.view.evidence).toBe('content-matches'); expect(f.journal.commit).not.toHaveBeenCalled();
  });
  it('keeps the lock if durable confirmation fails', async () => {
    const f = fixture(); f.remote.recover.mockResolvedValue({ status: 'succeeded', effects: 'possible', stage: 'confirmed', snapshot: f.snapshot, receipt: f.receipt });
    f.journal.commit.mockRejectedValue(new Error('disk full'));
    await expect(recoverFileTransaction(f.record, f.operation, f.remote, f.journal)).rejects.toThrow('disk full');
  });
  it('does not inspect through a different identity or a stale record', async () => {
    const f = fixture(); f.operation.scope.runAs = 'root';
    await expect(recoverFileTransaction(f.record, f.operation, f.remote, f.journal)).rejects.toThrow('identity'); expect(f.remote.recover).not.toHaveBeenCalled();
  });
  it('reports unavailable transport without replaying', async () => {
    const f = fixture(); f.remote.recover.mockRejectedValue(new Error('disconnected'));
    expect((await recoverFileTransaction(f.record, f.operation, f.remote, f.journal)).view.evidence).toBe('unavailable'); expect(f.remote.apply).not.toHaveBeenCalled();
  });
});
