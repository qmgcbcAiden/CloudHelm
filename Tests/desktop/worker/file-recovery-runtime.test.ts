import { beforeEach, expect, it, vi } from 'vitest';
import { HostSerialExecutor, TerminalManager, type FileRemotePort } from '@cloudhelm/application';
import { SshTransport, type InstalledNativeRuntime } from '@cloudhelm/adapters';
import type { FileTransactionRecord, ProposedOperation, RuntimeOperationPlan } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { NativeRuntimePreparation, type RuntimeResource } from '../../../apps/desktop/src/worker/native-runtime-preparation.js';
import { PrivilegedRuntime } from '../../../apps/desktop/src/worker/privileged-runtime.js';
import { recoverManagedFile } from '../../../apps/desktop/src/worker/file-recovery-runtime.js';

const state = vi.hoisted(() => ({ installs: [] as RuntimeOperationPlan[], commands: [] as string[], usernames: [] as string[],
  rootClosed: 0, uid: '0', failInstall: false, cleanups: 0 }));
vi.mock('@cloudhelm/adapters', async (original) => ({
  ...await original<typeof import('@cloudhelm/adapters')>(),
  nativeArtifact: async () => ({ artifact: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'a'.repeat(64), size: 7 }, bytes: Buffer.from('fixture') }),
  SshTransport: class {
    readonly installed = new Map<string, InstalledNativeRuntime>();
    username = '';
    connectionGeneration() { return 1; }
    isConnected() { return true; }
    nativeArchitecture() { return Promise.resolve('amd64'); }
    nativeInfo(host: string, session: string, generation: number) { return this.installed.get(JSON.stringify([host, session, generation])); }
    async installNative(hostId: string, plan: RuntimeOperationPlan, _bytes: Buffer, current: () => void, _signal: AbortSignal | undefined, terminalGeneration: number) {
      current(); state.installs.push(plan);
      if (state.failInstall) throw new Error('Injected installation failure');
      this.installed.set(JSON.stringify([hostId, plan.sessionId, terminalGeneration]), { hostId, sessionId: plan.sessionId,
        terminalGeneration, generation: 1, artifact: plan.artifact, directory: plan.directory, executable: plan.executable });
    }
    async connect(host: { username: string }) { this.username = host.username; state.usernames.push(host.username); }
    cleanupNative() { state.cleanups++; throw new Error('Recovery must not delete through the unresolved write lock'); }
    close() { if (this.username === 'root') state.rootClosed++; }
  },
  SshCommandTerminal: class {
    readonly agent = this;
    data = (_value: string) => {}; exit = (_code: number) => {};
    onData(callback: typeof this.data) { this.data = callback; }
    onExit(callback: typeof this.exit) { this.exit = callback; }
    onClose() {} onDisplay() {} resize() {} write() {} close() {}
    async execute(command: string, _cwd: string, current: () => boolean) {
      if (!current()) throw new Error('expired');
      state.commands.push(command); this.data(command === 'id -u' ? `${state.uid}\n` : 'unexpected\n'); this.exit(0);
    }
  }
}));

beforeEach(() => { state.installs = []; state.commands = []; state.usernames = []; state.rootClosed = 0;
  state.uid = '0'; state.failInstall = false; state.cleanups = 0; });
function fixture(identity = 'root') {
  const host: RuntimeHost = { id: 'host', label: 'Linux', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const record: FileTransactionRecord = { id: 'transaction', operationId: 'old-operation', taskId: 'task', hostId: host.id,
    fingerprint: 'b'.repeat(64), loginAs: identity, runAs: identity, stage: 'unknown', revision: 2, updatedAt: 1,
    plan: { version: 1, transactionId: 'transaction', before: { path: '/srv/config', exists: false,
      parent: { device: '1', inode: '2', size: 0, mtimeNs: '3', ctimeNs: '4' } }, contentSha256: 'c'.repeat(64), contentSize: 3,
      metadataPolicy: 'preserve-or-refuse', runtime: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'a'.repeat(64), size: 7 } } };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const resources: RuntimeResource[] = [];
  const native = new NativeRuntimePreparation(terminal, async (resource) => { resources.push(structuredClone(resource)); });
  const journal = { get: vi.fn(async () => record), commit: vi.fn(async (next: FileTransactionRecord) => next) };
  const remote = { artifact: record.plan.runtime, inspect: vi.fn(), apply: vi.fn(), cleanup: vi.fn(),
    recover: vi.fn(async () => ({ status: 'succeeded' as const, effects: 'possible' as const, stage: 'confirmed' as const,
      snapshot: { ...record.plan.before, exists: true, sha256: record.plan.contentSha256 },
      receipt: { transactionId: record.id, fingerprint: record.fingerprint, targetSha256: record.plan.contentSha256, deleted: false } })) } satisfies FileRemotePort;
  const ssh = new SshTransport();
  const privileged = new PrivilegedRuntime({ terminal, ssh, runtime: native, commands: { execute: terminal.execute.bind(terminal) },
    ordinary: { execute: vi.fn() }, files: () => ({ remote, journal }), jump: () => undefined,
    input: async () => 'SSH 登录 root' });
  const executor = new HostSerialExecutor({ execute: (operation, fingerprint, signal, options) =>
    (operation.kind === 'runtime' ? native : privileged).execute(operation, fingerprint, signal, options) });
  executor.restore([{ id: record.operationId, hostId: host.id }]);
  const deps = { terminal, ssh, native, privileged, executor, journal, files: () => ({ remote }), host: () => host,
    approval: async () => true, cancelApproval() {}, operation() {} };
  return { host, record, terminal, remote, journal, executor, deps, resources, privileged };
}

it.each(['root', 'user'])('F7 recovers as %s, closes its session, and journals retained resources without replay or unlocking', async (identity) => {
  const f = fixture(identity);
  const result = await recoverManagedFile(f.record, f.deps);
  expect(result).toMatchObject({ resolved: true, view: { evidence: 'receipt-confirmed' } });
  expect(state.usernames).toEqual(identity === 'root' ? ['root'] : []);
  expect(state.rootClosed).toBe(identity === 'root' ? 1 : 0);
  expect(state.installs).toHaveLength(1);
  expect(state.installs[0]).toMatchObject({ purpose: 'recover', action: 'install' });
  expect(state.commands).toEqual(identity === 'root' ? ['id -u'] : []);
  expect(f.resources.map((resource) => resource.state)).toEqual(['prepared', 'ready', 'unknown']);
  expect(f.terminal.currentGeneration(f.resources[0]!.terminalId)).toBe(-1);
  expect(state.cleanups).toBe(0); expect(f.privileged.forTask(f.record.taskId).confirmed?.()).toEqual([]);
  expect(f.remote.recover).toHaveBeenCalledOnce();
  expect(f.remote.apply).not.toHaveBeenCalled(); expect(f.remote.cleanup).not.toHaveBeenCalled();
  expect(f.journal.commit).toHaveBeenCalledWith(expect.objectContaining({ stage: 'confirmed', loginAs: identity, runAs: identity }), 2, expect.any(AbortSignal));
  const unrelated: ProposedOperation = { id: 'new-write', kind: 'write-file', path: '/srv/other', content: 'new', scope: {
    taskId: 'other', hostId: f.host.id, terminalId: 'unused', terminalGeneration: 1, cwd: '/srv', loginAs: 'user', runAs: 'user',
    policyRevision: 1, allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'write' } };
  expect(await f.executor.execute(unrelated, 'fingerprint')).toMatchObject({ status: 'failed', failureKind: 'unresolved-prior-operation' });
});

it.each(['read-failed', 'uid-failed', 'install-failed'] as const)('closes recovery root SSH and retains journaled runtime after %s', async (failure) => {
  const f = fixture();
  if (failure === 'read-failed') f.remote.recover.mockRejectedValueOnce(new Error('Read disconnected'));
  if (failure === 'uid-failed') state.uid = '1000';
  if (failure === 'install-failed') state.failInstall = true;
  const recovering = recoverManagedFile(f.record, f.deps);
  if (failure === 'read-failed') expect(await recovering).toMatchObject({ resolved: false, view: { evidence: 'unavailable' } });
  else await expect(recovering).rejects.toThrow();
  expect(state.rootClosed).toBe(1); expect(state.cleanups).toBe(0);
  expect(f.resources.at(-1)?.state).toBe('unknown');
  expect(f.terminal.currentGeneration(f.resources[0]!.terminalId)).toBe(-1);
  expect(f.privileged.forTask(f.record.taskId).confirmed?.()).toEqual([]);
  expect(f.remote.apply).not.toHaveBeenCalled(); expect(f.remote.cleanup).not.toHaveBeenCalled();
});
