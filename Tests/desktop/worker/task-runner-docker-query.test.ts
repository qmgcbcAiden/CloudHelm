import { describe, expect, it, vi } from 'vitest';
import { HostSerialExecutor, InteractionCoordinator, PermissionAwareExecutor, TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, type SshTransport } from '@cloudhelm/adapters';
import type { InputRequest, ProposedOperation, RawTerminal } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { OperationInputBridge } from '../../../apps/desktop/src/worker/operation-input-bridge.js';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

const images = "docker images --format '{{.Repository}}:{{.Tag}}\\t{{.ID}}\\t{{.Size}}\\t{{.CreatedSince}}'";
const sudoImages = "sudo docker images --format '{{.Repository}}:{{.Tag}} | {{.ID}} | {{.Size}} | {{.CreatedSince}}'";
const containers = "sudo docker ps -a --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}'";
const password = 'synthetic-docker-private-password';

/** No socket or shell. Only the real application protocol is exercised. */
class DockerTerminal implements RawTerminal {
  readonly agent: import('@cloudhelm/core').AgentExecutionPort = this;
  commands: string[] = [];
  private exited?: (code: number | undefined) => void;
  private output?: (data: string) => void;
  private auth?: (challenge: { id: string; prompt?: string }) => void;
  private waiting?: string;
  constructor(private readonly unknown = false) {}
  async execute(command: string): Promise<void> {
    this.commands.push(command);
    queueMicrotask(() => {
      if (command === images) {
        this.output?.('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n');
        this.exited?.(this.unknown ? undefined : 1);
      } else {
        this.waiting = `auth-${this.commands.length}`;
        this.auth?.({ id: this.waiting, prompt: 'sudo' });
      }
    });
  }
  answerAuthentication(id: string, answer: string | null): boolean {
    if (id !== this.waiting) return false;
    this.waiting = undefined;
    queueMicrotask(() => {
      if (answer !== password) {
        this.output?.('sudo: 1 incorrect password attempt\n'); this.exited?.(1); return;
      }
      this.output?.(this.commands.at(-1) === sudoImages ? 'nginx:alpine | abc123 | 20MB | 2 days ago\n' : 'web | nginx:alpine | Up 1 hour | 80/tcp\n');
      this.exited?.(0);
    });
    return true;
  }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  onData(listener: (data: string) => void): void { this.output = listener; }
  onAuthentication(listener: (challenge: { id: string; prompt?: string }) => void): void { this.auth = listener; }
  write(): void { throw new Error('No ordinary shell input, including credentials, is allowed'); }
  resize(): void {}
  close(): void {}
  onClose(): void {}
}

async function setup(authMode: 'success' | 'cancel' | 'reject' = 'success', unknown = false, locked = false) {
  let requests = 0;
  const fixture = await openAiFixture(async (request) => {
    if (request.review) throw new Error('Recognized metadata queries must use the existing low-risk policy');
    expect(JSON.stringify(request.messages)).not.toContain(password);
    expect(JSON.stringify(request.messages)).not.toContain('synthetic-wrong-password');
    if (++requests === 1) return { calls: [{ id: 'images', name: 'run_remote', arguments: { hostId: 'host', command: images } }] };
    if (requests === 2) {
      const feedback = fixtureMessageText(request.messages.find((message) => message.tool_call_id === 'images')!);
      expect(feedback).toContain('Effects: none');
      expect(feedback).toContain('no prior-effects verification is needed');
      return { calls: [{ id: 'sudo-images', name: 'run_remote', arguments: { hostId: 'host', command: sudoImages } }] };
    }
    if (authMode !== 'success' || unknown) throw new Error('A control stop must not request another model response');
    if (requests === 3) return { calls: [{ id: 'containers', name: 'run_remote', arguments: { hostId: 'host', command: containers } }] };
    expect(requests).toBe(4);
    return { text: '发现 nginx 镜像，web 容器正在使用它。镜像创建时间不等于拉取时间。' };
  });
  const host: RuntimeHost = { id: 'host', label: '测试', address: '192.0.2.1', port: 22, username: 'ubuntu', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: 'docker-query', goal: '当前SSH主机有哪些镜像，有什么用', hostIds: ['host'], localScopes: [],
    provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const diagnostics: unknown[] = [];
  const terminal = new TerminalManager({ data() {}, state() {}, completed: (result) => runner.recordRemoteResult(result) });
  const channel = new DockerTerminal(unknown);
  const terminalId = terminal.open(host.id, channel, task.id, '/home/ubuntu');
  const prompts: InputRequest[] = [];
  const interactions = new InteractionCoordinator(terminal, { opened(request) {
    prompts.push(request);
    queueMicrotask(() => {
      if (authMode === 'cancel') interactions.cancel(request.id);
      else void interactions.answer(request.id, authMode === 'success' ? password : 'synthetic-wrong-password');
    });
  }, closed() {} });
  const bridge = new OperationInputBridge(terminal, { connectionGeneration: () => 1 } as unknown as SshTransport, interactions);
  const executor = new HostSerialExecutor(new PermissionAwareExecutor(bridge, new BashAnalyzer()));
  if (locked) executor.restore([{ id: 'foreign-unknown-write', hostId: host.id }]);
  const approval = vi.fn(async () => false);
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
    [], terminal, executor, async () => terminalId, { clearCredentials: () => bridge.clearTask(task.id),
      diagnostic: (event) => diagnostics.push(event), event: (event) => events.push(structuredClone(event)),
      requestApproval: approval, cancelApproval() {} });
  return { task, runner, events, diagnostics, channel, prompts, approval, executor, terminalId, fixture, requests: () => requests };
}

describe('Docker metadata incident regression without SSH or a real model', () => {
  it.each([false, true])('corrects permissions, authenticates privately and ends without a report (other host lock=%s)', async (locked) => {
    const f = await setup('success', false, locked);
    try {
      await f.runner.start();
      expect(f.fixture.errors).toEqual([]);
      expect(f.requests()).toBe(4);
      expect(f.channel.commands).toEqual([images, sudoImages, containers]);
      expect(f.prompts).toHaveLength(2); // No host cache opt-in: each sudo challenge requires private input.
      expect(f.prompts.every((request) => request.allowPasswordCache === false)).toBe(true);
      expect(f.approval).not.toHaveBeenCalled();
      const operations = new Map<string, OperationView>();
      for (const event of f.events) if (event.type === 'operation') operations.set(event.value.id, event.value);
      for (const operation of operations.values()) {
        expect(operation.commandSource).toEqual({ version: 1, cwd: '/home/ubuntu' });
        expect(operation.intentKey).toMatch(/^[a-f0-9]{64}$/u);
      }
      expect([...operations.values()].map((operation) => [operation.status, operation.readOnly, operation.effects]))
        .toEqual([['failed', true, 'none'], ['succeeded', true, 'none'], ['succeeded', true, 'none']]);
      expect(f.events.some((event) => event.type === 'task-status' && event.status === 'paused')).toBe(false);
      expect(f.events.some((event) => event.type === 'verification-state' && event.value)).toBe(false);
      expect(f.events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered', resumeReason: undefined });
      await expect(f.runner.resume()).rejects.toThrow('没有可自动继续');
      expect(JSON.stringify([f.events, f.diagnostics])).not.toContain(password);
      if (locked) {
        const write: ProposedOperation = { id: 'blocked-write', kind: 'command', command: 'touch /tmp/file', scope: {
          taskId: f.task.id, hostId: 'host', cwd: '/', runAs: 'ubuntu', terminalId: f.terminalId,
          terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/'], protectedPaths: [], goal: 'test lock'
        } };
        expect(await f.executor.execute(write, 'not-dispatched', undefined, { readOnly: false }))
          .toMatchObject({ status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation' });
        expect(f.channel.commands).toHaveLength(3);
      }
    } finally { f.runner.dispose(); await f.fixture.close(); }
  });

  it.each(['cancel', 'reject'] as const)('does not continue after private authentication %s', async (mode) => {
    const f = await setup(mode);
    try {
      await f.runner.start();
      expect(f.fixture.errors).toEqual([]);
      expect(f.requests()).toBe(2);
      expect(f.channel.commands).toEqual([images, sudoImages]);
      expect(f.events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'paused' });
      expect(JSON.stringify([f.events, f.diagnostics])).not.toContain('synthetic-wrong-password');
    } finally { f.runner.dispose(); await f.fixture.close(); }
  });

  it('does not confuse a read-only classification with evidence of process exit', async () => {
    const f = await setup('success', true);
    try {
      await f.runner.start();
      expect(f.fixture.errors).toEqual([]);
      expect(f.requests()).toBe(1);
      expect(f.channel.commands).toEqual([images]);
      expect(f.events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'paused', resumeReason: 'verify' });
    } finally { f.runner.dispose(); await f.fixture.close(); }
  });
});
