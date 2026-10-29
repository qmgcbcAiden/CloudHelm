import { describe, expect, it, vi } from 'vitest';
import { InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import type { SshTransport } from '@cloudhelm/adapters';
import type { InputRequest, OperationExecutor, RawTerminal } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { OperationInputBridge } from '../../../apps/desktop/src/worker/operation-input-bridge.js';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

class SudoTerminal implements RawTerminal {
  readonly agent: import('@cloudhelm/core').AgentExecutionPort = this;
  commands: string[] = [];
  private exited?: (code: number | undefined) => void;
  private output?: (data: string) => void;
  private auth?: (challenge: { id: string; prompt?: string }) => void;
  private waiting?: string;
  async execute(command: string): Promise<void> {
    this.commands.push(command);
    queueMicrotask(() => {
      if (command === 'sudo -n true') { this.output?.('sudo: a password is required\n'); this.exited?.(1); return; }
      this.waiting = `auth-${this.commands.length}`;
      this.auth?.({ id: this.waiting, prompt: 'sudo' });
    });
  }
  answerAuthentication(id: string, answer: string | null): boolean {
    if (id !== this.waiting || answer !== 'synthetic-private-password') return false;
    this.waiting = undefined;
    queueMicrotask(() => {
      this.output?.(this.commands.at(-1) === 'sudo docker ps' ? 'Sorry, try again.\nCONTAINER ID IMAGE\n' : 'Image built\n');
      this.exited?.(0);
    });
    return true;
  }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  onData(listener: (data: string) => void): void { this.output = listener; }
  onAuthentication(listener: (challenge: { id: string; prompt?: string }) => void): void { this.auth = listener; }
  write(): void { throw new Error('Passwords must never enter ordinary stdin'); }
  resize(): void {}
  close(): void {}
  onClose(): void {}
}

describe('deployment sudo recovery through the model protocol, gate and authentication bridge', () => {
  it.each([
    'id; test -w /root && echo ROOT_WRITABLE || echo ROOT_NOT_WRITABLE; sudo -n true 2>&1 | head -1; echo done',
    'sudo cat /root/test | head -1',
    'sudo -S cat /root/test'
  ])('rejects unsupported authentication before approval without pausing: %s', async (command) => {
    let requests = 0;
    const fixture = await openAiFixture(async (request) => {
      requests++;
      if (requests === 1) return { calls: [{ id: 'unsupported', name: 'run_remote', arguments: { hostId: 'host', command } }] };
      const feedback = fixtureMessageText(request.messages.find((message) => message.tool_call_id === 'unsupported')!);
      expect(feedback).toContain('No command sent; effects: none');
      expect(feedback).toContain('unsupported by the private authentication channel');
      return { text: '命令未执行，应分别提交有界命令。' };
    });
    const host: RuntimeHost = { id: 'host', label: '测试', address: '192.0.2.1', port: 22, username: 'ubuntu', auth: 'agent',
      status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
    const task: TaskView = { id: 'unsupported-auth', goal: '检查 /root', hostIds: ['host'], localScopes: [],
      provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 3, createdAt: 1, updatedAt: 1 };
    const terminal = new TerminalManager({ data() {}, state() {} });
    const channel = new SudoTerminal(); const terminalId = terminal.open(host.id, channel, task.id, '/home/ubuntu');
    const requestApproval = vi.fn(async () => false);
    const events: Parameters<TaskSignals['event']>[0][] = [];
    const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
      [], terminal, { execute: vi.fn() }, async () => terminalId,
      { event: (event) => events.push(structuredClone(event)), requestApproval, cancelApproval() {} });
    try {
      await runner.start();
      expect(fixture.errors).toEqual([]);
      expect(requests).toBe(2);
      expect(requestApproval).not.toHaveBeenCalled();
      expect(channel.commands).toEqual([]);
      expect(events.some((event) => event.type === 'task-status' && event.status === 'paused')).toBe(false);
    } finally { runner.dispose(); await fixture.close(); }
  });
  it.each(['test -e /tmp && echo ok', 'printf "one;two" | head -1'])(
    'allows bounded non-sudo shell operators through normal review: %s', async (command) => {
      let requests = 0;
      const fixture = await openAiFixture(async (request) => {
        requests++;
        if (requests === 1) return { calls: [{ id: 'bounded', name: 'run_remote', arguments: { hostId: 'host', command } }] };
        expect(fixtureMessageText(request.messages.find((message) => message.tool_call_id === 'bounded')!)).toContain('ok');
        return { text: '查询已完成。' };
      });
      const host: RuntimeHost = { id: 'host', label: '测试', address: '192.0.2.1', port: 22, username: 'ubuntu', auth: 'agent',
        status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
      const task: TaskView = { id: 'bounded-query', goal: '检查状态', hostIds: ['host'], localScopes: [],
        provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 3, createdAt: 1, updatedAt: 1 };
      const terminal = new TerminalManager({ data() {}, state() {} });
      const terminalId = terminal.open(host.id, { onData() {}, onClose() {}, close() {} },
        task.id, '/home/ubuntu');
      const execute = vi.fn(async (...[operation]: Parameters<OperationExecutor['execute']>) => ({ operationId: operation.id,
        status: 'succeeded' as const, exitCode: 0, stdoutTail: 'ok' }));
      const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
        [], terminal, { execute }, async () => terminalId, { event() {}, requestApproval: async () => true, cancelApproval() {} });
      try {
        await runner.start();
        expect(fixture.errors).toEqual([]);
        expect(requests).toBe(2);
        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0]?.[0]).toMatchObject({ command });
      } finally { runner.dispose(); await fixture.close(); }
    });
  it.each(['sudo docker ps', 'sudo -n true', 'sudo -n -l'])('continues after %s without manual restart or another probe', async (first) => {
    let requests = 0;
    const fixture = await openAiFixture(async (request) => {
      if (request.review) throw new Error('Permissive fixture does not need a model review');
      requests++;
      expect(JSON.stringify(request.messages)).not.toContain('synthetic-private-password');
      if (requests === 1) return { calls: [{ id: 'initial', name: 'run_remote', arguments: { hostId: 'host', command: first } }] };
      if (requests === 2) {
        const result = fixtureMessageText(request.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'initial')!);
        if (first === 'sudo docker ps') { expect(result).toContain('Authentication: succeeded'); expect(result).not.toContain('Sorry, try again.'); }
        else { expect(result).toContain('No command sent'); expect(result).toContain('不被支持'); }
        return { calls: [{ id: 'build', name: 'run_remote', arguments: { hostId: 'host', cwd: '/srv/app', command: 'sudo docker compose build' } }] };
      }
      expect(requests).toBe(3);
      return { text: '镜像构建完成。' };
    });
    const host: RuntimeHost = { id: 'host', label: '测试', address: '192.0.2.1', port: 22, username: 'ubuntu', auth: 'agent',
      status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
    const task: TaskView = { id: 'sudo-recovery', goal: '构建部署镜像', hostIds: ['host'], localScopes: [], provider: 'cloudhelm-custom',
      modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 5, createdAt: 1, updatedAt: 1 };
    const terminal = new TerminalManager({ data() {}, state() {} });
    const channel = new SudoTerminal(); const terminalId = terminal.open(host.id, channel, task.id, '/home/ubuntu');
    const prompts: InputRequest[] = [];
    const interactions = new InteractionCoordinator(terminal, { opened: (request) => {
      prompts.push(request); queueMicrotask(() => { void interactions.answer(request.id, 'synthetic-private-password'); });
    }, closed() {} });
    const bridge = new OperationInputBridge(terminal, { connectionGeneration: () => 1 } as unknown as SshTransport, interactions);
    const events: Parameters<TaskSignals['event']>[0][] = [];
    const diagnostics: unknown[] = [];
    const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
      [], terminal, bridge, async () => terminalId, { clearCredentials: () => bridge.clearTask(task.id),
        diagnostic: (event) => diagnostics.push(event), event: (event) => events.push(structuredClone(event)),
        requestApproval: async () => false, cancelApproval() {} });
    try {
      await runner.start();
      expect(fixture.errors).toEqual([]); expect(requests).toBe(3);
      expect(prompts).toHaveLength(first === 'sudo docker ps' ? 2 : 1);
      expect(prompts.every((request) => request.allowPasswordCache === false)).toBe(true);
      // Capability probes are refused before review and never dispatched.
      expect(channel.commands).toEqual(first === 'sudo docker ps' ? [first, 'sudo docker compose build'] : ['sudo docker compose build']);
      expect(events.filter((event) => event.type === 'operation' && event.value.preview === 'sudo docker compose build').at(-1))
        .toMatchObject({ value: { status: 'succeeded', runAs: 'root' } });
      expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'operation.proposed', runAs: 'root', cwd: '/srv/app' }));
      const conclusion = events.findIndex((event) => event.type === 'task-message' && event.role === 'agent' && event.text === '镜像构建完成。');
      expect(conclusion).toBeGreaterThan(-1);
      // The fixture omits submit_verification, so normal end-of-turn acceptance may pause.
      expect(events.slice(0, conclusion).some((event) => event.type === 'task-status' && event.status === 'paused')).toBe(false);
      expect(JSON.stringify([events, diagnostics])).not.toContain('synthetic-private-password');
    } finally { runner.dispose(); await fixture.close(); }
  });
});
