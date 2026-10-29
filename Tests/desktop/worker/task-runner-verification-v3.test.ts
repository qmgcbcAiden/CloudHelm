import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { RawTerminal } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
  status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
const task = (): TaskView => ({ id: 'triangle', goal: '运行已有脚本并检查三角形输出', hostIds: ['host'], localScopes: [], status: 'draft',
  provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 });
const channel: RawTerminal = { close() {}, onData() {}, onClose() {} };

it.each(['passed', 'wrong-output', 'truncated', 'no-notes'] as const)('finishes %s without report repair loops or replaying a command', async (scenario) => {
  let requests = 0;
  const expected = '*\n**\n***\n'; const output = scenario === 'wrong-output' ? 'wrong\n' : expected;
  const fixture = await openAiFixture(async (request) => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'run', name: 'run_remote', arguments: { hostId: 'host', command: 'python3 /srv/test.py' } }] };
    if (requests === 2 && scenario !== 'no-notes') {
      const operationId = /Operation ID: ([^\n]+)/u.exec(fixtureMessageText(request.messages.find((message) => message.tool_call_id === 'run')!))![1]!;
      return { calls: [{ id: 'notes', name: 'submit_verification', arguments: { version: 3,
        summary: '本次输出与影响分开记录', checks: [{ kind: 'run-output', operationId, expectedOutput: expected }] } }] };
    }
    return { text: '根据已有记录说明输出结果和影响限制，不再重复运行。' };
  });
  const view = task(); const events: Parameters<TaskSignals['event']>[0][] = [];
  const terminal = new TerminalManager({ data() {}, state() {} });
  const execute = vi.fn(async (operation: { id: string }) => ({ operationId: operation.id, status: 'succeeded' as const,
    exitCode: 0, stdoutTail: output, outputCapture: { totalChars: output.length, tailChars: output.length, truncated: scenario === 'truncated' } }));
  const runner = new TaskRunner(view, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    [], terminal, { execute }, async () => terminal.open(host.id, channel, view.id, '/srv'),
    { event: (event) => events.push(structuredClone(event)), requestApproval: async () => true, cancelApproval() {} });
  try {
    await runner.start();
    expect(fixture.errors).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toBe(scenario === 'no-notes' ? 2 : 3);
    expect(view.status).toBe('answered'); expect(view.resumeReason).toBeUndefined();
    expect(view.report?.facts).toMatchObject({ execution: 'succeeded', impact: 'not-assessed',
      goals: scenario === 'passed' ? 'passed' : scenario === 'wrong-output' ? 'failed' : scenario === 'truncated' ? 'inconclusive' : 'execution-observed',
      registration: scenario === 'no-notes' ? 'automatic' : 'submitted' });
    expect(view.verificationRound).toMatchObject({ closed: true, operationIds: expect.any(Array) });
    expect(view.verificationRound?.operationIds).toHaveLength(1);
    await expect(runner.resume()).rejects.toThrow('没有可自动继续');
    expect(events.filter((event) => event.type === 'work-report' && event.report)).toHaveLength(1);
  } finally { runner.dispose(); await fixture.close(); }
});

it('keeps a legacy missing-report round when an ordinary message asks to finish it', async () => {
  const original: OperationView = { id: 'write', taskId: 'triangle', hostId: 'host', kind: 'write-file', readOnly: false,
    status: 'succeeded', preview: 'write /srv/test.py', effects: 'possible', createdAt: 1 };
  const fixture = await openAiFixture(async () => ({ text: '只整理原有结果，不重复变更；目标效果仍未检查。' }));
  const view = { ...task(), status: 'answered' as const, resumeReason: 'report' as const,
    verificationState: { status: 'unverified' as const, operationIds: ['write'], reasonCode: 'report-missing' as const } } as TaskView;
  const terminal = new TerminalManager({ data() {}, state() {} }); const execute = vi.fn();
  const runner = new TaskRunner(view, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    [original], terminal, { execute }, async () => { throw new Error('No terminal needed'); },
    { event() {}, requestApproval: async () => false, cancelApproval() {} });
  try {
    await runner.start(true);
    // start(true) restores the runner to paused; emulate persisted answered/report at the dispatch boundary.
    Object.assign(runner, { status: 'answered', resumeReason: 'report', needsRecovery: false });
    const roundId = view.verificationRound!.id;
    runner.message('请补一下验收报告');
    await vi.waitFor(() => expect(view.status).toBe('answered'), { timeout: 15000 });
    expect(fixture.errors).toEqual([]); expect(execute).not.toHaveBeenCalled();
    expect(view.verificationRound).toMatchObject({ id: roundId, operationIds: ['write'], closed: true });
    expect(view.report?.facts?.operations).toEqual([expect.objectContaining({ operationId: 'write' })]);
    expect(view.verificationState?.operationIds).toContain('write');
    expect(view.resumeReason).toBeUndefined();
  } finally { runner.dispose(); await fixture.close(); }
});
