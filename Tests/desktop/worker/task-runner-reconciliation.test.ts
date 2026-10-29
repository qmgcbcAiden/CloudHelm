import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawTerminal } from '@cloudhelm/core';
import { HostSerialExecutor, TerminalManager } from '@cloudhelm/application';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

class InspectionTerminal implements RawTerminal {
  readonly agent: import('@cloudhelm/core').AgentExecutionPort = this;
  commands: string[] = [];
  private output?: (text: string) => void;
  private exit?: (code: number | undefined) => void;
  async execute(command: string): Promise<void> {
    this.commands.push(command);
    queueMicrotask(() => { this.output?.('File: /tmp/config\nSize: 12\n'); this.exit?.(0); });
  }
  onData(callback: (text: string) => void): void { this.output = callback; }
  onExit(callback: (code: number | undefined) => void): void { this.exit = callback; }
  onClose(): void {}
  write(): void { throw new Error('No interactive shell input in this fixture'); }
  resize(): void {}
  close(): void {}
}

it.each(['evidence', 'risk-accepted', 'acceptance-race'] as const)('restores %s recovery without duplicate records, checks or replay', async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudhelm-reconciliation-'));
  let seeded = false;
  let requests = 0;
  let checkId = '';
  const fixture = await openAiFixture(async ({ messages, review }) => {
    if (review) throw new Error('The literal stat is already a classified low-risk query');
    if (!seeded) { seeded = true; return { text: '原操作结果尚不确定，不能直接重放。' }; }
    requests++;
    if (requests === 1) {
      const context = messages.map(fixtureMessageText).join('\n');
      expect(context).toContain('"unresolvedOperationIds":' + (mode !== 'risk-accepted' ? '["original"]' : '[]'));
      if (mode === 'risk-accepted') {
        expect(context).toContain('"kind":"risk-accepted"');
        expect(context).toContain('"status":"unknown"');
        return { text: '原结果仍不确定，您已接受该风险；没有将其当作成功，也没有重放命令。' };
      }
      return { calls: [{ id: 'check', name: 'run_remote', arguments: { hostId: 'host', command: 'stat /tmp/config' } }] };
    }
    if (requests === 2) {
      const observation = fixtureMessageText(messages.find((message) => message.tool_call_id === 'check')!);
      checkId = observation.match(/Operation ID: ([^\n]+)/u)![1]!;
      return { calls: [{ id: 'resolve', name: 'record_reconciled_result', arguments: { operationId: 'original',
        evidenceOperationIds: [checkId], outcome: 'succeeded', explanation: '通过现有stat只读检查确认目标文件已经存在。' } }] };
    }
    if (requests === 3) {
      expect(fixtureMessageText(messages.find((message) => message.tool_call_id === 'resolve')!)).toContain('outcome-recorded');
      return { calls: [{ id: 'report', name: 'submit_verification', arguments: { version: 3, summary: '确认测试文件存在',
        recovery: ['恢复前保留现有文件副本'], checks: [{ kind: 'model-assessment', target: '/tmp/config', expected: '文件存在',
          observed: 'stat返回文件元数据', evidenceOperationId: checkId, status: 'passed' }] } }] };
    }
    expect(requests).toBe(4);
    expect(fixtureMessageText(messages.find((message) => message.tool_call_id === 'report')!)).toContain('Notes recorded.');
    if (mode === 'acceptance-race') {
      // The main-process commit was delayed while the worker assessed the old outcome.
      expect(serial.reconcile(host.id, original.id)).toBe(true);
      runner.recordRiskAcceptance(accepted);
      return { text: '风险确认已保存；原操作结果仍不确定，不能把风险接受当成成功。' };
    }
    return { text: '已通过现有只读检查确认文件存在，没有重复执行原创建命令。' };
  });
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user',
    auth: 'agent', status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: 'task', goal: '创建测试文件', hostIds: ['host'], localScopes: [], provider: 'cloudhelm-custom',
    modelId: 'fixture', status: 'paused', resumeReason: 'verify', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const original: OperationView = { id: 'original', taskId: 'task', hostId: 'host', kind: 'command', preview: 'touch /tmp/config',
    status: 'unknown', readOnly: false, effects: 'possible', createdAt: 1 };
  const accepted: OperationView = { ...original, reconciledAt: 42, reconciliation: { kind: 'risk-accepted',
    at: 42, explanation: '用户接受不确定性，但这不是观察证据。', sourceTaskId: task.id, evidenceOperationIds: [] } };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  let runner: TaskRunner;
  const terminal = new TerminalManager({ data() {}, state() {}, completed: (result) => runner.recordRemoteResult(result) });
  const channel = new InspectionTerminal();
  let terminalId = terminal.open(host.id, channel, task.id, '/');
  const serial = new HostSerialExecutor(terminal);
  serial.restore([{ id: original.id, hostId: original.hostId }]);
  const reconcile = vi.spyOn(serial, 'reconcile');
  const makeRunner = (restore: boolean) => new TaskRunner(task, [host],
    { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
    [original], terminal, serial, async () => terminalId,
    { event: (event) => events.push(structuredClone(event)), requestApproval: async () => false, cancelApproval() {} },
    undefined, undefined, { id: task.id, directory, restore });
  runner = makeRunner(false);
  try {
    // Production restoration requires a bound native transcript, including its system sections.
    await runner.start();
    expect(fixture.errors).toEqual([]);
    expect(fixture.requests, `Native fixture initialization status: ${task.status}; ${task.summary ?? ''}`).toHaveLength(1);
    expect(channel.commands).toEqual([]);
    runner.dispose();
    expect(terminal.hostOf(terminalId)).toBeUndefined();
    terminalId = terminal.open(host.id, channel, task.id, '/');
    runner = makeRunner(true);
    await runner.start(true);
    expect(fixture.requests).toHaveLength(1); // Loading history itself never dispatches a request.
    events.length = 0;
    if (mode === 'risk-accepted') {
      expect(serial.reconcile(host.id, original.id)).toBe(true);
      runner.recordRiskAcceptance(accepted);
    }
    await runner.resume();
    expect(fixture.errors).toEqual([]);
    expect(channel.commands).toEqual(mode !== 'risk-accepted' ? ['stat /tmp/config'] : []);
    expect(requests).toBe(mode !== 'risk-accepted' ? 4 : 1);
    expect(reconcile).toHaveBeenCalledTimes(mode === 'acceptance-race' ? 2 : 1);
    expect(original.reconciliation?.kind).toBe(mode !== 'risk-accepted' ? 'evidence' : undefined);
    expect(original.status).toBe(mode !== 'risk-accepted' ? 'succeeded' : 'unknown');
    if (mode !== 'evidence') expect(events.filter((event) => event.type === 'work-report').at(-1))
      .toMatchObject({ report: { facts: { impact: 'risk-accepted', riskOperationIds: ['original'] } } });
    expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered', resumeReason: undefined });
    expect(events.filter((event) => event.type === 'verification-state').at(-1))
      .toMatchObject({ value: { status: 'unverified', operationIds: ['original'] } });
    await expect(runner.resume()).rejects.toThrow('没有可自动继续');
  } finally { runner.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
