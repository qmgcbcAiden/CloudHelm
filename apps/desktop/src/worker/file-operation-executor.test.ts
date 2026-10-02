import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SshTransport } from '@cloudhelm/adapters';
import { TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, type ProposedOperation } from '@cloudhelm/core';
import { FileOperationExecutor } from './file-operation-executor.js';
import { LocalFileAccess } from './local-file-access.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const terminal = new TerminalManager({ data() {}, state() {} });
  const id = terminal.open('host', { write() {}, resize() {}, close() {}, onData() {}, onClose() {} }, 'task');
  const scope = { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: id, terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy' };
  const writeFile = vi.fn(); const deleteFile = vi.fn();
  const ssh = { writeFile, deleteFile, connectionGeneration: () => 1 } as unknown as SshTransport;
  const commands = { execute: vi.fn() };
  return { terminal, id, scope, writeFile, deleteFile, commands, executor: new FileOperationExecutor(terminal, ssh, commands) };
}

describe('structured operation authorization continuity', () => {
  it('does not dispatch an upload when policy changes during local file loading', async () => {
    const f = fixture(); let authorized = true; const data = Buffer.from('file');
    vi.spyOn(LocalFileAccess.prototype, 'read').mockImplementation(async () => {
      authorized = false; return { data, scope: { path: '/source', kind: 'directory' } };
    });
    const operation: ProposedOperation = { id: 'upload', kind: 'upload', localRoot: '/source', localPath: '/source/file', remotePath: '/srv/app/file',
      size: data.length, contentSha256: createHash('sha256').update(data).digest('hex'), scope: f.scope };
    expect((await f.executor.execute(operation, operationFingerprint(operation), undefined, { isAuthorized: () => authorized })).status).toBe('failed');
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it('passes a live lease and policy guard through to SFTP mutation boundaries', async () => {
    const f = fixture(); let authorized = true;
    f.writeFile.mockImplementation(async (_host: string, _path: string, _content: Buffer, assertAuthorized: () => void) => {
      assertAuthorized(); authorized = false; assertAuthorized();
    });
    const operation: ProposedOperation = { id: 'write', kind: 'write-file', path: '/srv/app/file', content: 'new', scope: f.scope };
    expect((await f.executor.execute(operation, operationFingerprint(operation), undefined, { isAuthorized: () => authorized })).status).toBe('unknown');
    expect(f.writeFile).toHaveBeenCalledOnce();
  });

  it('passes the same authorization capability to command execution', async () => {
    const f = fixture(); const options = { readOnly: true, isAuthorized: () => true };
    f.commands.execute.mockResolvedValue({ operationId: 'read', status: 'succeeded', stdoutTail: '' });
    const operation: ProposedOperation = { id: 'read', kind: 'command', command: 'cat /srv/app/file', scope: f.scope };
    await f.executor.execute(operation, operationFingerprint(operation), undefined, options);
    expect(f.commands.execute).toHaveBeenCalledWith(operation, operationFingerprint(operation), undefined, options);
  });
});
