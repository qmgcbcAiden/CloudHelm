import { describe, expect, it, vi } from 'vitest';
import { SafetyGate, TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, type InstalledNativeRuntime, type SshTransport } from '@cloudhelm/adapters';
import type { ProposedOperation, RuntimeOperationPlan } from '@cloudhelm/core';
import { NativeRuntimePreparation, type RuntimeResource } from '../../../apps/desktop/src/worker/native-runtime-preparation.js';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

vi.mock('@cloudhelm/adapters', async (original) => ({ ...await original<typeof import('@cloudhelm/adapters')>(),
  nativeArtifact: async () => ({ artifact: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'a'.repeat(64), size: 7 }, bytes: Buffer.from('fixture') })
}));

function fixture() {
  const terminal = new TerminalManager({ data() {}, state() {} });
  const records: RuntimeResource[] = [];
  const persist = vi.fn(async (record: RuntimeResource) => { records.push(structuredClone(record)); });
  const native = new NativeRuntimePreparation(terminal, persist);
  const installed = new Map<string, InstalledNativeRuntime>();
  let connection = 1;
  const transport = { connectionGeneration: () => connection, nativeArchitecture: async () => 'amd64',
    nativeInfo: (host: string, session: string, generation: number) => installed.get(JSON.stringify([host, session, generation])),
    installNative: vi.fn(async (host: string, plan: RuntimeOperationPlan, _bytes: Buffer, current: () => void, _signal: AbortSignal | undefined, generation: number) => {
      current(); installed.set(JSON.stringify([host, plan.sessionId, generation]), { hostId: host, terminalGeneration: generation,
        generation: connection, sessionId: plan.sessionId, artifact: plan.artifact, directory: plan.directory, executable: plan.executable });
    }),
    cleanupNative: vi.fn(async (host: string, plan: RuntimeOperationPlan, generation: number, current: () => void) => {
      current(); installed.delete(JSON.stringify([host, plan.sessionId, generation]));
    }) };
  const audited: ProposedOperation[] = [];
  let approval = true;
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), evaluator: { evaluate: async () => 'allow' },
    approvals: { requestApproval: async () => approval }, executor: native, lease: terminal,
    settings: () => ({ mode: 'permissive', revision: 1 }), audit: {
      proposed: async (operation) => { audited.push(operation); }, decided: async () => {}, completed: async () => {}
    } });
  const operation = (taskId: string, sessionId?: string): ProposedOperation => {
    const terminalId = terminal.open('host', { onData() {}, onClose() {}, close() {} }, taskId);
    return { id: `operation-${taskId}-${terminalId}`, kind: 'command', command: 'id', scope: { taskId, hostId: 'host', terminalId,
      terminalGeneration: 1, sessionId, loginAs: 'deploy', runAs: 'deploy', cwd: '/tmp', policyRevision: 1,
      allowedWorkingRoots: ['/tmp'], protectedPaths: [], goal: 'fixture' } };
  };
  return { native, terminal, records, persist, transport, ssh: transport as unknown as SshTransport, audited, gate, operation,
    disconnect: () => { connection++; }, deny: () => { approval = false; } };
}

describe('audited native resource ownership and cleanup', () => {
  it('installs once per terminal session, reuses only within its binding, and cleans only the selected task', async () => {
    const f = fixture(); const first = f.operation('one'); const second = f.operation('two');
    const a = await f.native.ensure(first, f.gate, f.ssh); await f.native.ensure(first, f.gate, f.ssh);
    const b = await f.native.ensure(second, f.gate, f.ssh);
    expect(a.directory).not.toBe(b.directory); expect(f.transport.installNative).toHaveBeenCalledTimes(2);
    expect(f.records.filter((item) => item.state === 'prepared')).toHaveLength(2);
    // Normal completion releases the business lease; cleanup receives its own backend lease.
    f.terminal.releaseIdle(first.scope.terminalId);
    await f.native.cleanupTask('one', f.gate);
    expect(f.transport.cleanupNative).toHaveBeenCalledTimes(1);
    expect(f.records.filter((item) => item.taskId === 'one').map((item) => [item.state, item.revision]))
      .toEqual([['prepared', 1], ['ready', 2], ['cleaning', 3], ['closed', 4]]);
    expect(f.records.filter((item) => item.taskId === 'two').at(-1)?.state).toBe('ready');
    const cleanup = f.audited.find((item) => item.kind === 'runtime' && item.runtime.action === 'cleanup')!;
    expect(cleanup.scope.terminalId).not.toBe(first.scope.terminalId);
    expect(f.terminal.currentGeneration(cleanup.scope.terminalId)).toBe(-1);
    await f.native.cleanupTask('two', f.gate);
  });

  it.each(['disconnected', 'uncertain'] as const)('preserves %s resources for verification without deleting them', async (kind) => {
    const f = fixture(); const operation = f.operation('one', 'root-session');
    await f.native.ensure(operation, f.gate, f.ssh);
    const close = vi.fn(); f.native.retireSession('one', 'root-session', close);
    if (kind === 'disconnected') f.disconnect(); else await f.native.markUnknown(undefined, 'one');
    await f.native.cleanupTask('one', f.gate);
    expect(f.transport.cleanupNative).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    expect(f.records.at(-1)?.state).toBe('unknown');
    await f.native.cleanupTask('one', f.gate); expect(f.transport.cleanupNative).not.toHaveBeenCalled();
  });

  it('records an interrupted cleanup as unknown and never retries its possibly completed deletion', async () => {
    const f = fixture(); await f.native.ensure(f.operation('one'), f.gate, f.ssh);
    f.transport.cleanupNative.mockRejectedValueOnce(new Error('lost cleanup confirmation'));
    await f.native.cleanupTask('one', f.gate); await f.native.cleanupTask('one', f.gate);
    expect(f.transport.cleanupNative).toHaveBeenCalledOnce(); expect(f.records.at(-1)).toMatchObject({ state: 'unknown', revision: 4 });
  });

  it('abandons only the recovery session and closes its retained connection without deleting resources', async () => {
    const f = fixture(); const recovery = f.operation('one', 'recovery'); const other = f.operation('one', 'other');
    await f.native.ensure(recovery, f.gate, f.ssh); await f.native.ensure(other, f.gate, f.ssh);
    const close = vi.fn(); f.native.retireSession('one', 'recovery', close);
    await f.native.abandonSession('one', 'recovery');
    expect(close).toHaveBeenCalledOnce(); expect(f.transport.cleanupNative).not.toHaveBeenCalled();
    expect(f.records.filter((record) => record.plan.sessionId === 'recovery').at(-1)?.state).toBe('unknown');
    expect(f.records.filter((record) => record.plan.sessionId === 'other').at(-1)?.state).toBe('ready');
    await f.native.cleanupTask('one', f.gate);
    expect(f.transport.cleanupNative).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(f.records.filter((record) => record.plan.sessionId === 'recovery').at(-1)?.state).toBe('unknown');
  });

  it('closes an abandoned root connection even if the resource journal acknowledgment fails', async () => {
    const f = fixture(); await f.native.ensure(f.operation('one', 'recovery'), f.gate, f.ssh);
    const close = vi.fn(); f.native.retireSession('one', 'recovery', close);
    f.persist.mockRejectedValueOnce(new Error('Lost journal ACK'));
    await expect(f.native.abandonSession('one', 'recovery')).rejects.toThrow('Lost journal ACK');
    expect(close).toHaveBeenCalledOnce(); expect(f.transport.cleanupNative).not.toHaveBeenCalled();
    await f.native.cleanupTask('one', f.gate);
    expect(close).toHaveBeenCalledOnce(); expect(f.transport.cleanupNative).not.toHaveBeenCalled();
    expect(f.records.at(-1)?.state).toBe('unknown');
  });

  it('runs su cleanup through its retained root controller before closing that transport', async () => {
    const f = fixture(); const operation = f.operation('one', 'root-session');
    const info = await f.native.ensure(operation, f.gate, f.ssh);
    const directory = `/tmp/cloudhelm-root-${'b'.repeat(8)}-bbbb-bbbb-bbbb-${'b'.repeat(12)}`;
    await f.native.bootstrap(operation, { version: 1, action: 'su-bootstrap', directory, executable: `${directory}/helper`,
      artifact: info.artifact, sessionId: 'root-session', purpose: 'execute', parentOperationId: operation.id }, f.gate, f.ssh, async () => {});
    const order: string[] = [];
    f.native.retireSession('one', 'root-session', () => order.push('close'), async (current) => { current(); order.push('cleanup-root'); });
    await f.native.cleanupTask('one', f.gate);
    expect(order).toEqual(['cleanup-root', 'close']);
    expect(f.records.filter((item) => item.plan.action === 'su-bootstrap').at(-1)?.state).toBe('closed');
    expect(f.transport.cleanupNative).toHaveBeenCalledOnce();
  });

  it('refuses an executor call with no backend-minted runtime capability', async () => {
    const f = fixture(); const base = f.operation('one');
    const operation: ProposedOperation = { ...base, kind: 'runtime', runtime: { version: 1, action: 'cleanup',
      directory: '/tmp/arbitrary', executable: '/tmp/arbitrary/helper', sessionId: 'forged', purpose: 'execute', parentOperationId: 'op',
      artifact: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'a'.repeat(64), size: 7 } } };
    expect(await f.native.execute(operation, 'forged', undefined, { isAuthorized: () => true })).toMatchObject({ status: 'failed', effects: 'none' });
    expect(f.transport.cleanupNative).not.toHaveBeenCalled(); expect(f.records).toEqual([]);
  });

  it('uses the maintenance Gate after a task answers, then waits for cleanup before disposal', async () => {
    const f = fixture(); await f.native.ensure(f.operation('one'), f.gate, f.ssh);
    const model = await openAiFixture(async () => ({ text: '任务已完成。' }));
    const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'deploy', auth: 'agent',
      status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
    const task: TaskView = { id: 'one', goal: '说明当前状态', hostIds: ['host'], localScopes: [], status: 'draft', provider: 'cloudhelm-custom',
      modelId: 'fixture', requestCount: 0, requestLimit: 5, createdAt: 1, updatedAt: 1 };
    const cleanup = vi.fn(async (gate, knownIdle, refresh) => {
      expect(knownIdle).toBe(true); await f.native.cleanupTask(task.id, gate, refresh);
    });
    const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture', baseUrl: model.baseUrl },
      [], f.terminal, f.native, async () => { throw new Error('No business terminal required'); },
      { event() {}, requestApproval: async () => true, cancelApproval() {}, cleanupRuntime: cleanup });
    try {
      await runner.start(); await runner.close();
      expect(model.errors).toEqual([]); expect(task.status, task.summary).toBe('answered');
      expect(cleanup).toHaveBeenCalled(); expect(f.transport.cleanupNative).toHaveBeenCalledOnce();
      expect(f.records.at(-1)?.state).toBe('closed');
    } finally { runner.dispose(); await model.close(); }
  });
});
