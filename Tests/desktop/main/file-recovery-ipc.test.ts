import { beforeEach, expect, it, vi } from 'vitest';
import type { FileTransactionRecord } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import { registerFileRecoveryIpc } from '../../../apps/desktop/src/main/file-recovery-ipc.js';
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } }));
beforeEach(() => handlers.clear());
const hash = 'a'.repeat(64);
function setup(evidence = 'receipt-confirmed', durable = true, lostUnlockAck = false) {
  const record = { id: 'transaction', operationId: 'operation', taskId: 'task', hostId: 'host', fingerprint: hash,
    stage: 'unknown', plan: { before: { path: '/srv/config' }, contentSha256: hash } } as FileTransactionRecord;
  const operation: OperationView = { id: 'operation', taskId: 'task', hostId: 'host', kind: 'write-file',
    preview: 'write', status: 'unknown', effects: 'possible', createdAt: 1, fileTransactionId: 'transaction' };
  const view = { transactionId: 'transaction', operationId: 'operation', taskId: 'task', hostId: 'host',
    target: '/srv/config', evidence, observedAt: 10 };
  let confirmed = false; let persisted = false;
  const state = { snapshot: () => ({ operations: [operation] }), getHost: () => ({ status: 'connected' }),
    record: vi.fn((event: { value: OperationView }) => { if (!durable) throw new Error('disk full'); persisted = true; Object.assign(operation, event.value); }) };
  const store = { get: () => confirmed ? { ...record, stage: 'confirmed', receipt: { transactionId: 'transaction', fingerprint: hash } } : record };
  const runtime = { call: vi.fn(async (call: { method: string }) => {
    if (call.method === 'recover-file-transaction') { confirmed = true; return { view, resolved: evidence === 'receipt-confirmed' }; }
    if (call.method === 'commit-file-recovery') { expect(persisted).toBe(true); if (lostUnlockAck) { lostUnlockAck = false; throw new Error('ACK lost'); } }
  }) };
  registerFileRecoveryIpc(state as never, runtime as never, store as never, vi.fn());
  return { state, runtime, view, invoke: () => handlers.get('cloudhelm:recover-file-transaction')!({}, 'transaction') };
}
it('F7 persists a verified original receipt before releasing the host lock', async () => {
  const f = setup(); await expect(f.invoke()).resolves.toEqual({ ...f.view, lockState: 'confirmed' });
  expect(f.state.record).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ reconciledAt: 10 }) }));
  expect(f.runtime.call).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'commit-file-recovery' }));
});
it('F7 never releases the host lock for matching content without original receipt evidence', async () => {
  const f = setup('content-matches'); await f.invoke();
  expect(f.runtime.call.mock.calls.map(([call]) => call.method)).not.toContain('commit-file-recovery');
  expect(f.state.record).toHaveBeenCalledWith(expect.objectContaining({ value: expect.not.objectContaining({ reconciledAt: 10 }) }));
});
it('F7 holds the write lock when main process persistence fails after native recovery', async () => {
  const f = setup('receipt-confirmed', false); await expect(f.invoke()).rejects.toThrow('disk full');
  expect(f.runtime.call.mock.calls.map(([call]) => call.method)).not.toContain('commit-file-recovery');
});

it('F7 retries a lost unlock acknowledgment without rereading or replaying the remote transaction', async () => {
  const f = setup('receipt-confirmed', true, true);
  await expect(f.invoke()).rejects.toThrow('ACK lost');
  await expect(f.invoke()).resolves.toMatchObject({ evidence: 'receipt-confirmed', lockState: 'confirmed' });
  expect(f.runtime.call.mock.calls.filter(([call]) => call.method === 'recover-file-transaction')).toHaveLength(1);
  expect(f.runtime.call.mock.calls.filter(([call]) => call.method === 'commit-file-recovery')).toHaveLength(2);
});
