import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ClientChannel } from 'ssh2';
import type { FileOperationPlan, NativeBinding, ProposedOperation } from '@cloudhelm/core';
import { NativeFileClient } from '../../packages/adapters/src/native-file-client.js';

const binding: NativeBinding = { version: 1, sessionId: 'session', operationId: 'operation', generation: 1 };
const artifact = { protocolVersion: 1 as const, platform: 'linux' as const, arch: 'amd64' as const, sha256: 'a'.repeat(64), size: 1 };
const plan: FileOperationPlan = { version: 1, transactionId: 'txn', before: { path: '/srv/file', exists: false, parent: { device: '1', inode: '2', size: 0, mtimeNs: '3', ctimeNs: '4' } },
  contentSha256: 'b'.repeat(64), contentSize: 3, metadataPolicy: 'preserve-or-refuse', runtime: artifact };
const operation: Extract<ProposedOperation, { kind: 'write-file' }> = { id: 'operation', kind: 'write-file', path: '/srv/file', content: 'new', filePlan: plan,
  scope: { taskId: 'task', hostId: 'host', cwd: '/srv', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'write' } };
class Channel extends EventEmitter { stderr = new EventEmitter(); write = vi.fn(); destroy = vi.fn(); }
function fixture(assertCurrent?: () => void) {
  const channel = new Channel(); const client = new NativeFileClient(artifact, async () => ({ channel: channel as unknown as ClientChannel, binding, assertCurrent }));
  const send = (type: string, result: unknown, override = {}) => channel.emit('data', Buffer.from(JSON.stringify({ ...binding, ...override, type, result }) + '\n'));
  return { channel, client, send };
}
const staged = { status: 'unknown', effects: 'possible', stage: 'staged', directory: '/srv/.cloudhelm-txn-txn' };
const confirmed = { status: 'succeeded', effects: 'possible', stage: 'confirmed', directory: '/srv/.cloudhelm-txn-txn',
  receipt: { transactionId: 'txn', fingerprint: 'c'.repeat(64), targetSha256: plan.contentSha256, deleted: false },
  snapshot: { ...plan.before, exists: true, identity: { ...plan.before.parent, inode: '4', size: 3 }, metadata: { uid: 1, gid: 1, mode: 0o600, xattrs: {} }, sha256: plan.contentSha256 } };
describe('native file wire authority', () => {
  it('waits for durable staging acknowledgment before sending commit', async () => {
    const f = fixture(); let acknowledge!: () => void; const ack = new Promise<void>((resolve) => { acknowledge = resolve; });
    const pending = f.client.apply(operation, 'c'.repeat(64), Buffer.from('new'), undefined, () => {}, () => ack);
    await Promise.resolve(); expect(f.channel.write).toHaveBeenCalledTimes(1);
    f.send('file-staged', staged); await Promise.resolve(); expect(f.channel.write).toHaveBeenCalledTimes(1);
    acknowledge(); await Promise.resolve(); await Promise.resolve(); expect(f.channel.write).toHaveBeenCalledTimes(2);
    expect(f.channel.write.mock.calls[1]?.[0]).toContain('file-commit'); f.send('file-result', confirmed);
    expect((await pending).status).toBe('succeeded');
  });
  it('does not commit if authorization expires during the durable acknowledgment', async () => {
    const f = fixture(); let allowed = true;
    const pending = f.client.apply(operation, 'c'.repeat(64), Buffer.from('new'), undefined, () => { if (!allowed) throw new Error('revoked'); }, async () => { allowed = false; });
    const rejection = expect(pending).rejects.toThrow('authorization'); await Promise.resolve(); f.send('file-staged', staged); await rejection;
    expect(f.channel.write).toHaveBeenCalledTimes(1); expect(f.channel.destroy).toHaveBeenCalled();
  });
  it('rejects stale response bindings', async () => {
    const f = fixture(); const pending = f.client.inspect(operation, '/srv/file'); const rejection = expect(pending).rejects.toThrow('binding');
    await Promise.resolve(); f.send('file-result', {}, { generation: 2 }); await rejection;
  });
  it('rejects successful completion before granting commit', async () => {
    const f = fixture(); const pending = f.client.apply(operation, 'c'.repeat(64), Buffer.from('new')); const rejection = expect(pending).rejects.toThrow('not authorized');
    await Promise.resolve(); f.send('file-result', confirmed); await rejection;
  });
  it('accepts an empty inspected file without manufacturing content', async () => {
    const f = fixture(); const pending = f.client.inspect(operation, '/srv/file'); await Promise.resolve();
    f.send('file-result', { status: 'inspected', effects: 'none', snapshot: plan.before });
    expect((await pending).content.length).toBe(0);
  });
  it('does not persist a staging path outside the transaction', async () => {
    const f = fixture(); const journal = vi.fn(); const pending = f.client.apply(operation, 'c'.repeat(64), Buffer.from('new'), undefined, undefined, journal);
    const rejection = expect(pending).rejects.toThrow('Unexpected'); await Promise.resolve(); f.send('file-staged', { ...staged, directory: '/etc' }); await rejection;
    expect(journal).not.toHaveBeenCalled();
  });
  it('checks the opener read guard before dispatch when no write authorization callback exists', async () => {
    const f = fixture(() => { throw new Error('read policy changed'); });
    await expect(f.client.recover(operation, 'c'.repeat(64))).rejects.toThrow('not dispatched');
    expect(f.channel.write).not.toHaveBeenCalled(); expect(f.channel.destroy).toHaveBeenCalled();
  });
  it.each(['inspect', 'recover'] as const)('rejects a %s result when read protection changes in flight', async (method) => {
    let readable = true; const f = fixture(() => { if (!readable) throw new Error('read policy changed'); });
    const pending = method === 'inspect' ? f.client.inspect(operation, '/srv/file') : f.client.recover(operation, 'c'.repeat(64));
    const rejection = expect(pending).rejects.toThrow('authorization expired');
    await Promise.resolve(); expect(f.channel.write).toHaveBeenCalledOnce(); readable = false;
    f.send('file-result', method === 'inspect' ? { status: 'inspected', effects: 'none', snapshot: plan.before } : confirmed);
    await rejection; expect(f.channel.destroy).toHaveBeenCalled();
  });
  it('rechecks the opener guard after the staging ACK before sending commit', async () => {
    let current = true; const f = fixture(() => { if (!current) throw new Error('policy changed'); });
    const pending = f.client.apply(operation, 'c'.repeat(64), Buffer.from('new'), undefined, undefined, async () => { current = false; });
    const rejection = expect(pending).rejects.toThrow('authorization');
    await Promise.resolve(); f.send('file-staged', staged); await rejection;
    expect(f.channel.write).toHaveBeenCalledOnce();
  });
});
