import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { operationFingerprint, type NativeArtifact, type ProposedOperation, type RuntimeOperationPlan } from '@cloudhelm/core';
import { prepareFileOperation, type ManagedFileOperation } from '@cloudhelm/application';
import { HostKeyError, SshTransport, type SshHost } from '../../packages/adapters/src/ssh-transport.js';
import { NativeFileClient } from '../../packages/adapters/src/native-file-client.js';

const testKey = process.env.CLOUDHELM_TEST_SSH_KEY;
const run = testKey ? it : it.skip;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
describe('SSH transport against an opt-in local Linux SSH server', () => {
  run('verifies the host key, opens a PTY and commits native file transactions without SFTP', async () => {
    const transport = new SshTransport();
    const host: SshHost = { id: 'smoke-host', label: 'Local test server', address: '127.0.0.1', port: Number(process.env.CLOUDHELM_TEST_SSH_PORT ?? '22388'),
      username: process.env.CLOUDHELM_TEST_SSH_USER ?? process.env.USER ?? '', auth: 'private-key', privateKeyPath: testKey };
    let runtime: RuntimeOperationPlan | undefined;
    let installed = false;
    try {
      try { await transport.connect(host, {}); } catch (error) { expect(error).toBeInstanceOf(HostKeyError); host.fingerprint = (error as HostKeyError).fingerprint; }
      expect(host.fingerprint).toMatch(/^SHA256:/u); await transport.connect(host, {});
      const shell = await transport.shell(host.id);
      const output = new Promise<string>((resolve, reject) => {
        let buffer = ''; const timeout = setTimeout(() => reject(new Error('PTY did not echo the executed command')), 5000);
        shell.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8'); if (buffer.includes('cloudhelm-pty-ok')) { clearTimeout(timeout); resolve(buffer); } });
      });
      shell.write("printf 'cloudhelm-pty-ok\\n'\n"); expect(await output).toContain('cloudhelm-pty-ok'); shell.end();
      const arch = await transport.nativeArchitecture(host.id);
      const manifest = JSON.parse(await readFile(new URL('../../apps/desktop/resources/native/manifest.json', import.meta.url), 'utf8')) as { artifacts: Array<NativeArtifact & { filename: string }> };
      const selected = manifest.artifacts.find((entry) => entry.arch === arch)!; expect(selected).toBeTruthy();
      const { filename, ...artifact } = selected;
      const bytes = await readFile(new URL(`../../apps/desktop/resources/native/${filename}`, import.meta.url));
      const remoteRoot = process.env.CLOUDHELM_TEST_REMOTE_ROOT ?? '/tmp';
      const directory = `${remoteRoot}/cloudhelm-run-${randomUUID()}`;
      runtime = { version: 1, action: 'install', directory, executable: `${directory}/helper`, artifact, sessionId: randomUUID(), purpose: 'execute' };
      await transport.installNative(host.id, runtime, bytes, () => {}); installed = true;
      const client = new NativeFileClient(artifact, async (operation, _signal, assertAuthorized) => {
        assertAuthorized?.(); const channel = await transport.openPipe(host.id, `${quote(runtime!.executable)} --files`);
        return { channel, binding: { version: 1, sessionId: runtime!.sessionId, operationId: operation.id, generation: transport.connectionGeneration(host.id) } };
      });
      const remote = `${remoteRoot}/cloudhelm-file-test-${randomUUID()}`;
      const scope = { taskId: 'test', hostId: host.id, cwd: remoteRoot, runAs: host.username, loginAs: host.username,
        terminalId: 'test', terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [remoteRoot], protectedPaths: [], goal: 'Native file fixture' };
      const completed: ManagedFileOperation[] = [];
      for (const content of ['first', 'second']) {
        const operation: ProposedOperation = { id: randomUUID(), kind: 'write-file', path: remote, content, scope };
        const prepared = await prepareFileOperation(operation, client, async () => { throw new Error('No uploads in this test'); });
        const result = await client.apply(prepared.operation, operationFingerprint(prepared.operation), Buffer.from(content), undefined, () => {}, async () => {});
        expect(result.status).toBe('succeeded'); expect(result.receipt).toBeTruthy(); completed.push(prepared.operation);
      }
      const deletion = await prepareFileOperation({ id: randomUUID(), kind: 'delete-path', path: remote, scope }, client, async () => { throw new Error('No upload'); });
      const deleted = await client.apply(deletion.operation, operationFingerprint(deletion.operation), undefined, undefined, () => {}, async () => {});
      expect(deleted.status).toBe('succeeded'); completed.push(deletion.operation);
      for (const operation of completed) expect((await client.cleanup(operation, operationFingerprint(operation), undefined, () => {})).status).toBe('cleaned');
    } finally {
      if (installed && runtime) await transport.cleanupNative(host.id, { ...runtime, action: 'cleanup' }, 1, () => {});
      transport.close();
    }
  }, 40_000);
});
