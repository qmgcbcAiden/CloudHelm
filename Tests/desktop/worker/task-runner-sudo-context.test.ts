import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { HostSerialExecutor, InteractionCoordinator, PermissionAwareExecutor, TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, SshTransport } from '@cloudhelm/adapters';
import type { InputRequest, NativeBinding, OperationResult } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { OperationInputBridge } from '../../../apps/desktop/src/worker/operation-input-bridge.js';
import { FileOperationExecutor } from '../../../apps/desktop/src/worker/file-operation-executor.js';
import { PrivilegedRuntime } from '../../../apps/desktop/src/worker/privileged-runtime.js';
import type { NativeRuntimePreparation } from '../../../apps/desktop/src/worker/native-runtime-preparation.js';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

afterEach(() => vi.restoreAllMocks());
class ProtocolChannel extends EventEmitter {
  stderr = new EventEmitter(); writes: unknown[] = [];
  binding?: NativeBinding;
  constructor(private readonly behavior: 'retry' | 'denied' | 'required') { super(); }
  write(value: string): void {
    const message = JSON.parse(value); this.writes.push(message);
    if (message.type === 'launch') {
      this.binding = { version: message.version, operationId: message.operationId, sessionId: message.sessionId, generation: message.generation };
      queueMicrotask(() => {
      this.event({ type: 'started', pid: 123, supervisorUid: 1000, supervisorEuid: 1000 });
      if (this.behavior !== 'retry') { this.event({ type: 'data', data: this.behavior === 'denied' ? 'sudo: fixture is not in the sudoers file.\n' : 'sudo: a password is required\n' }); this.event({ type: 'exit', code: 1 }); }
      else this.event({ type: 'auth', id: 'a'.repeat(32), prompt: '[sudo] password for fixture:' });
      });
    }
    if (message.type === 'answer') queueMicrotask(() => {
      this.event({ type: 'auth-close', id: message.id });
      if (message.id === 'a'.repeat(32)) { this.event({ type: 'data', data: 'Sorry, try again.\n' }); this.event({ type: 'auth', id: 'b'.repeat(32), prompt: '[sudo] password for fixture:' }); }
      else { this.event({ type: 'data', data: 'fixture file exists\n' }); this.event({ type: 'exit', code: 0 }); }
    });
  }
  event(value: Record<string, unknown>): void {
    const event = value.type === 'data' ? { type: 'data', dataBase64: Buffer.from(String(value.data)).toString('base64') }
      : value.type === 'auth' ? { ...value, promptSha256: createHash('sha256').update(String(value.prompt)).digest('hex') } : value;
    this.emit('data', Buffer.from(`${JSON.stringify({ ...this.binding, ...event })}\n`));
  }
  end(): void {} close(): void { this.emit('close'); }
}

it.each(['retry', 'denied', 'required'] as const)('runs default sudo through native tools, Gate and private authentication without replay (%s)', async (behavior) => {
  const connect = vi.spyOn(SshTransport.prototype, 'connect').mockRejectedValue(new Error('Real SSH is forbidden in this fixture'));
  let count = 0; const requests: string[] = [];
  // A security-config target deliberately requires human review; ordinary touch may be auto-allowed.
  const command = behavior === 'required' ? 'sudo -n touch /etc/ssh/fixture' : 'stat /root/fixture';
  const feedbackCode = behavior === 'required' ? 'authentication-required' : 'authorization-denied';
  const fixture = await openAiFixture(async (request) => {
    requests.push(JSON.stringify(request.messages)); count++;
    if (count === 1) return { calls: [{ id: 'prepare', name: 'request_root_session', arguments: {
      hostId: 'host', command, cwd: '/', reason: 'Read the authorized fixture metadata' } }] };
    if (count === 2) {
      const context = JSON.parse(fixtureMessageText(request.messages.find((item) => item.tool_call_id === 'prepare')!));
      expect(context).toMatchObject({ method: 'sudo', state: 'prepared', identityVerified: false });
      return { calls: [{ id: 'inspect', name: 'run_remote', arguments: { hostId: 'host', command, cwd: '/', sessionId: context.sessionId } }] };
    }
    if (behavior !== 'retry') expect(requests.at(-1)).toContain(feedbackCode);
    return { text: behavior === 'required' ? '需要认证且原操作影响未确认，未重放。' : behavior === 'denied' ? '当前命令观察到 sudo 授权限制，不再尝试其他身份。' : '已取得本次文件元数据观察。' };
  });
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'fixture', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: `sudo-context-${behavior}`, goal: behavior === 'required' ? '在授权路径写入fixture标记' : '检查授权文件元数据，不修改', hostIds: ['host'], localScopes: [], status: 'draft',
    provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = []; const channels: ProtocolChannel[] = [];
  const terminal = new TerminalManager({ data() {}, state() {}, completed: (result: OperationResult) => runner.recordRemoteResult(result) });
  const inputs: InputRequest[] = [];
  const interactions = new InteractionCoordinator(terminal, { opened: (input) => {
    inputs.push(input); queueMicrotask(() => void interactions.answer(input.id, inputs.length === 1 ? 'synthetic-wrong' : 'synthetic-correct'));
  }, closed() {} });
  const ssh = { connectionGeneration: () => 1, prepareCommandProgram: vi.fn(async () => '/tmp/cloudhelm-run.fixture/helper'),
    removeCommandProgram: vi.fn(async () => {}), openPipe: vi.fn(async () => { const channel = new ProtocolChannel(behavior); channels.push(channel); return channel; }),
    shell: async () => { throw new Error('No shell is allowed'); } } as unknown as SshTransport;
  const bridge = new OperationInputBridge(terminal, ssh, interactions);
  const privateInput = vi.fn(async (input: { kind: string }) => { expect(input.kind).toBe('confirmation'); expect(channels).toHaveLength(0); return '使用 sudo（推荐）'; });
  const privileged = new PrivilegedRuntime({ terminal, ssh, ordinary: new FileOperationExecutor(terminal, ssh, bridge), commands: bridge,
    runtime: { ensure: async () => { throw new Error('Fixture must not use SSH/su'); }, retireSession: () => false } as unknown as NativeRuntimePreparation,
    files: () => { throw new Error('Fixture must not perform a file transaction'); }, jump: () => undefined, input: privateInput });
  const approve = vi.fn(async (approval: { preview: string; account?: string }) => {
    expect(approval).toMatchObject({ preview: behavior === 'required' ? command : 'sudo -- stat /root/fixture', account: 'root' }); return true;
  });
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl }, [], terminal,
    new HostSerialExecutor(new PermissionAwareExecutor(privileged, new BashAnalyzer())), async () => { throw new Error('No alternate terminal allowed'); },
    { event: (event) => events.push(structuredClone(event)), requestApproval: approve, cancelApproval() {}, clearCredentials: () => bridge.clearTask(task.id) },
    undefined, privileged.forTask(task.id));
  try {
    await runner.start(); expect(fixture.errors).toEqual([]); expect(channels).toHaveLength(1); expect(privateInput).toHaveBeenCalledOnce(); expect(approve).toHaveBeenCalledOnce();
    const launches = channels.flatMap((channel) => channel.writes).filter((value: any) => value.type === 'launch');
    expect(launches).toEqual([expect.objectContaining({ payload: expect.objectContaining({ argv: behavior === 'required' ? ['sudo', '-A', '-n', 'touch', '/etc/ssh/fixture'] : ['sudo', '-A', '--', 'stat', '/root/fixture'], sudo: true }) })]);
    const operations = new Map<string, OperationView>(); for (const event of events) if (event.type === 'operation') operations.set(event.value.id, event.value);
    expect([...operations.values()]).toHaveLength(1); expect([...operations.values()][0]?.preview).toBe(behavior === 'required' ? command : 'sudo -- stat /root/fixture');
    if (behavior === 'retry') {
      expect(count).toBe(3); expect(inputs).toHaveLength(2); expect(inputs[1]?.prompt).toContain('第 2/3 次请求');
      expect(task.status).toBe('answered'); expect([...operations.values()][0]).toMatchObject({ status: 'succeeded', readOnly: true, authenticationAttempts: 2 });
    } else {
      expect(count).toBe(2); expect(inputs).toHaveLength(0); expect(task).toMatchObject({ status: 'paused', resumeReason: behavior === 'required' ? 'verify' : 'interrupted' });
      expect([...operations.values()][0]?.privilege).toMatchObject({ code: feedbackCode, source: 'output-inference', businessCommand: 'unknown' });
      if (behavior === 'required') expect([...operations.values()][0]).toMatchObject({ effects: 'possible', readOnly: false });
      runner.message('不要再尝试提权，只说明权限不足');
      await vi.waitFor(() => { expect(count).toBe(3); expect(task.status).toBe(behavior === 'required' ? 'paused' : 'answered'); }, { timeout: 15000 }); expect(channels).toHaveLength(1);
    }
    expect(connect).not.toHaveBeenCalled();
    expect(requests.join('')).not.toContain('synthetic-wrong'); expect(requests.join('')).not.toContain('synthetic-correct');
  } finally { runner.dispose(); bridge.clearTask(task.id); await fixture.close(); }
});
