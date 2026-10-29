import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SshTransport } from '@cloudhelm/adapters';
import { TerminalManager, fileContentHash, type FileRemotePort } from '@cloudhelm/application';
import { operationFingerprint, type FileOperationPlan, type FileTransactionJournal, type FileTransactionRecord, type ProposedOperation } from '@cloudhelm/core';
import { FileOperationExecutor } from '../../../apps/desktop/src/worker/file-operation-executor.js';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const terminal = new TerminalManager({ data() {}, state() {} });
  const id = terminal.open('host', { close() {}, onData() {}, onClose() {} }, 'task');
  const scope = { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: id, terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy' };
  const remote = { artifact: { protocolVersion: 1 as const, platform: 'linux' as const, arch: 'amd64' as const, sha256: 'a'.repeat(64), size: 1 }, inspect: vi.fn(), apply: vi.fn(), recover: vi.fn(), cleanup: vi.fn() } satisfies FileRemotePort;
  let stored: FileTransactionRecord | undefined;
  const journal = { get: vi.fn(async () => stored), commit: vi.fn(async (record: FileTransactionRecord) => { stored = structuredClone(record); return stored; }) } satisfies FileTransactionJournal;
  const ssh = { connectionGeneration: () => 1 } as unknown as SshTransport;
  const commands = { execute: vi.fn() };
  const plan: FileOperationPlan = { version: 1, transactionId: 'txn-1', before: { path: '/srv/app/file', exists: false,
    parent: { device: '1', inode: '2', size: 0, mtimeNs: '3', ctimeNs: '4' } }, contentSha256: fileContentHash(Buffer.from('new')), contentSize: 3, metadataPolicy: 'preserve-or-refuse', runtime: remote.artifact };
  const operation: ProposedOperation = { id: 'write', kind: 'write-file', path: '/srv/app/file', content: 'new', filePlan: plan, scope };
  return { terminal, id, scope, ssh, remote, journal, commands, operation, executor: new FileOperationExecutor(terminal, ssh, commands, () => ({ remote, journal })) };
}
describe('structured native transaction continuity', () => {
  it('does not dispatch an upload when policy changes during local loading', async () => {
    const f = fixture(); let authorized = true; const data = Buffer.from('new');
    vi.spyOn(LocalFileAccess.prototype, 'read').mockImplementation(async () => { authorized = false; return { data, scope: { path: '/source', kind: 'directory' } }; });
    const operation: ProposedOperation = { id: 'upload', kind: 'upload', localRoot: '/source', localPath: '/source/file', remotePath: '/srv/app/file',
      size: 3, contentSha256: fileContentHash(data), filePlan: 'filePlan' in f.operation ? f.operation.filePlan : undefined, scope: f.scope };
    expect((await f.executor.execute(operation, operationFingerprint(operation), undefined, { isAuthorized: () => authorized })).status).toBe('failed');
    expect(f.remote.apply).not.toHaveBeenCalled();
  });
  it('requires durable preparation before any remote change', async () => {
    const f = fixture(); f.journal.commit.mockRejectedValue(new Error('storage unavailable'));
    const result = await f.executor.execute(f.operation, operationFingerprint(f.operation));
    expect(result).toMatchObject({ status: 'failed', effects: 'none' }); expect(f.remote.apply).not.toHaveBeenCalled();
  });
  it('acknowledges staged journal before granting commit and rejects takeover there', async () => {
    const f = fixture(); let authorized = true;
    f.remote.apply.mockImplementation(async (_operation, _hash, _content, _signal, check, staged) => {
      check?.(); await staged?.({ status: 'unknown', effects: 'possible', stage: 'staged', directory: '/srv/app/.cloudhelm-txn-1' });
      expect(f.journal.commit).toHaveBeenCalledTimes(2); authorized = false; check?.(); throw new Error('unreachable');
    });
    const result = await f.executor.execute(f.operation, operationFingerprint(f.operation), undefined, { isAuthorized: () => authorized });
    expect(result.status).toBe('unknown'); expect(f.journal.commit.mock.calls.at(-1)?.[0].stage).toBe('unknown');
  });
  it('does not replay an existing transaction', async () => {
    const f = fixture(); f.journal.get.mockResolvedValue({ id: 'txn-1' } as FileTransactionRecord);
    expect((await f.executor.execute(f.operation, operationFingerprint(f.operation))).status).toBe('unknown');
    expect(f.remote.apply).not.toHaveBeenCalled();
  });
  it('fails closed without a reviewed native plan rather than falling back to SFTP', async () => {
    const f = fixture(); const operation = { ...f.operation, filePlan: undefined };
    expect((await f.executor.execute(operation, operationFingerprint(operation))).failureKind).toBe('unsupported');
    expect('writeFile' in f.ssh).toBe(false);
  });
  it('passes command capabilities through unchanged', async () => {
    const f = fixture(); const options = { readOnly: true, isAuthorized: () => true };
    f.commands.execute.mockResolvedValue({ operationId: 'read', status: 'succeeded', stdoutTail: '' });
    const operation: ProposedOperation = { id: 'read', kind: 'command', command: 'cat /srv/app/file', scope: f.scope };
    await f.executor.execute(operation, operationFingerprint(operation), undefined, options);
    expect(f.commands.execute).toHaveBeenCalledWith(operation, operationFingerprint(operation), undefined, options);
  });
});
