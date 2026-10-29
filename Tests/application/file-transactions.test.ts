import { describe, expect, it, vi } from 'vitest';
import type { FileSnapshot, NativeArtifact } from '@cloudhelm/core';
import { fileContentHash, prepareFileOperation, type FileRemotePort, type ManagedFileOperation } from '../../packages/application/src/file-transactions.js';

const artifact: NativeArtifact = { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'a'.repeat(64), size: 1 };
const scope = { taskId: 'task', hostId: 'host', cwd: '/srv', runAs: 'user', terminalId: 'term', terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'write' };
const parent = { device: '1', inode: '2', size: 0, mtimeNs: '3', ctimeNs: '4' };
function remote(old: string) {
  const content = Buffer.from(old);
  const snapshot: FileSnapshot = { path: '/srv/file', parent, exists: true, identity: { ...parent, inode: '5', size: content.length }, metadata: { uid: 1, gid: 1, mode: 0o640, xattrs: {} }, sha256: fileContentHash(content) };
  return { artifact, inspect: vi.fn().mockResolvedValue({ snapshot, content }), apply: vi.fn(), recover: vi.fn(), cleanup: vi.fn() } satisfies FileRemotePort;
}
describe('file preparation', () => {
  it('binds old/new bytes and runtime but separates the complete human preview', async () => {
    const file: ManagedFileOperation = { id: 'write', kind: 'write-file', path: 'file', content: 'new', scope };
    const result = await prepareFileOperation(file, remote('old private body'), vi.fn());
    expect(result.preview.before).toBe('old private body'); expect(result.preview.after).toBe('new');
    expect(JSON.stringify(result.operation.filePlan)).not.toContain('old private body');
    expect(result.operation.filePlan?.before.sha256).toBe(fileContentHash(Buffer.from('old private body')));
    expect(result.operation.filePlan?.contentSha256).toBe(fileContentHash(Buffer.from('new')));
  });
  it('rejects an upload changed before review without inspecting the remote', async () => {
    const port = remote('old');
    const file: ManagedFileOperation = { id: 'upload', kind: 'upload', localPath: '/source/file', localRoot: '/source', remotePath: 'file', size: 3, contentSha256: fileContentHash(Buffer.from('old')), scope };
    await expect(prepareFileOperation(file, port, async () => Buffer.from('new'))).rejects.toThrow('changed');
    expect(port.inspect).not.toHaveBeenCalled();
  });
  it('rejects unbounded or hash-inconsistent inspection', async () => {
    const port = remote('old'); port.inspect.mockResolvedValue({ snapshot: { path: '/srv/file', parent, exists: true, sha256: 'a'.repeat(64) }, content: Buffer.from('old') });
    await expect(prepareFileOperation({ id: 'write', kind: 'write-file', path: 'file', content: 'new', scope }, port, vi.fn())).rejects.toThrow('snapshot');
  });
  it('renders binary content losslessly for a human without putting it in the plan', async () => {
    const port = remote('old'); const bytes = Buffer.from([0, 255, 12]);
    const file: ManagedFileOperation = { id: 'upload', kind: 'upload', localPath: '/source/file', localRoot: '/source', remotePath: 'file', size: bytes.length, contentSha256: fileContentHash(bytes), scope };
    const result = await prepareFileOperation(file, port, async () => bytes);
    expect(result.preview.encoding).toBe('base64'); expect(result.preview.after).toBe(bytes.toString('base64'));
    expect(result.operation.filePlan?.contentSize).toBe(bytes.length);
  });
});
