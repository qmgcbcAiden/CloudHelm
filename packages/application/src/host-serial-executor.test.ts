import { describe, expect, it, vi } from 'vitest';
import type { OperationResult, ProposedOperation } from '@cloudhelm/core';
import { HostSerialExecutor } from './host-serial-executor.js';

const operation: ProposedOperation = { id: 'one', kind: 'command', command: 'sleep 10', scope: {
  taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: ['/tmp'], protectedPaths: [], goal: 'Wait'
} };

describe('cross-task host write isolation', () => {
  it('revalidates authorization after waiting for a host lock and never sends an expired queued operation', async () => {
    let finishFirst!: (result: OperationResult) => void;
    const firstResult = new Promise<OperationResult>((resolve) => { finishFirst = resolve; });
    const downstream = { execute: vi.fn().mockReturnValueOnce(firstResult)
      .mockResolvedValue({ operationId: 'later', status: 'succeeded', stdoutTail: '' }) };
    const serial = new HostSerialExecutor(downstream);
    const first = serial.execute(operation, 'first-fingerprint');
    await vi.waitFor(() => expect(downstream.execute).toHaveBeenCalledTimes(1));
    let authorized = true;
    const isAuthorized = vi.fn(() => authorized);
    const queued = serial.execute({ ...operation, id: 'queued', scope: { ...operation.scope, taskId: 'another-task' } },
      'queued-fingerprint', undefined, { isAuthorized });
    expect(isAuthorized).not.toHaveBeenCalled();
    expect(downstream.execute).toHaveBeenCalledTimes(1);
    authorized = false;
    finishFirst({ operationId: operation.id, status: 'succeeded', stdoutTail: '' });
    await first;
    expect(await queued).toMatchObject({ operationId: 'queued', status: 'failed', stdoutTail: expect.stringContaining('Authorization expired') });
    expect(isAuthorized).toHaveBeenCalledOnce();
    expect(downstream.execute).toHaveBeenCalledTimes(1);
    expect((await serial.execute({ ...operation, id: 'later' }, 'new-fingerprint', undefined, { isAuthorized: () => true })).status).toBe('succeeded');
    expect(downstream.execute).toHaveBeenCalledTimes(2);
    expect(downstream.execute.mock.calls.some(([request]) => request.id === 'queued')).toBe(false);
  });

  it('blocks another Agent write until a handed-over command is seen exiting', async () => {
    let finish!: (value: 'exited' | 'unknown') => void;
    const remoteCompletion = new Promise<'exited' | 'unknown'>((resolve) => { finish = resolve; });
    const downstream = { execute: vi.fn().mockResolvedValueOnce({ operationId: 'one', status: 'handed-over',
      stdoutTail: '', remoteCompletion }).mockResolvedValue({ operationId: 'two', status: 'succeeded', stdoutTail: '' }) };
    const serial = new HostSerialExecutor(downstream);
    await serial.execute(operation, 'fingerprint');
    const second = { ...operation, id: 'two' };
    expect((await serial.execute(second, 'fingerprint')).status).toBe('failed');
    expect(downstream.execute).toHaveBeenCalledOnce();
    finish('exited');
    await remoteCompletion;
    await Promise.resolve();
    expect((await serial.execute(second, 'fingerprint')).status).toBe('succeeded');
  });
  it('allows read-only reconciliation after restart but blocks writes until each unknown record is resolved', async () => {
    const downstream = { execute: vi.fn().mockResolvedValue({ operationId: 'inspection', status: 'succeeded', stdoutTail: '' }) };
    const serial = new HostSerialExecutor(downstream);
    serial.restore([{ id: 'previous-a', hostId: 'host' }, { id: 'previous-b', hostId: 'host' }]);
    expect((await serial.execute(operation, 'fingerprint')).status).toBe('failed');
    expect((await serial.execute(operation, 'fingerprint', undefined, { readOnly: true })).status).toBe('succeeded');
    expect(serial.reconcile('host', 'previous-a')).toBe(true);
    expect((await serial.execute(operation, 'fingerprint')).status).toBe('failed');
    expect(serial.reconcile('host', 'previous-b')).toBe(true);
    expect((await serial.execute(operation, 'fingerprint')).status).toBe('succeeded');
  });

  it('does not release a running command when an inspection fails or becomes unknown', async () => {
    let finish!: (value: 'exited' | 'unknown') => void;
    const remoteCompletion = new Promise<'exited' | 'unknown'>((resolve) => { finish = resolve; });
    const downstream = { execute: vi.fn()
      .mockResolvedValueOnce({ operationId: 'one', status: 'handed-over', stdoutTail: '', remoteCompletion })
      .mockRejectedValueOnce(new Error('inspection disconnected'))
      .mockResolvedValue({ operationId: 'later', status: 'succeeded', stdoutTail: '' }) };
    const serial = new HostSerialExecutor(downstream);
    await serial.execute(operation, 'fingerprint');
    await expect(serial.execute({ ...operation, id: 'inspection' }, 'fingerprint', undefined, { readOnly: true })).rejects.toThrow('disconnected');
    expect(serial.reconcile('host', 'inspection')).toBe(true);
    expect(serial.reconcile('host', 'one')).toBe(false);
    expect((await serial.execute({ ...operation, id: 'later' }, 'fingerprint')).status).toBe('failed');
    finish('unknown');
    await remoteCompletion;
    expect(serial.reconcile('host', 'one')).toBe(true);
    expect((await serial.execute({ ...operation, id: 'later' }, 'fingerprint')).status).toBe('succeeded');
  });
});
