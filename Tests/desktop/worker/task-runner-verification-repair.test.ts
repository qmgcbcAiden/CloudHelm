import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { RawTerminal } from '@cloudhelm/core';
import type { TaskView, VerificationSubmissionV3 } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

it('repairs one source reference without hand-maintained coverage or replaying business commands', async () => {
  let requests = 0;
  let draft: VerificationSubmissionV3;
  let runId = '';
  const fixture = await openAiFixture(async (request) => {
    requests++;
    if (requests === 1) {
      const definition = request.tools!.find((tool) => tool.function.name === 'submit_verification')!.function;
      const schema = (definition as typeof definition & { parameters: { required: string[] } }).parameters;
      expect(schema.required).toEqual(['version']);
      return { calls: [{ id: 'create', name: 'run_remote', arguments: { hostId: 'host', command: 'mkdir -p /srv/report-fixture' } }] };
    }
    if (requests === 2) return { calls: [{ id: 'script', name: 'run_remote', arguments: { hostId: 'host', command: 'python3 /srv/report-fixture/test.py' } }] };
    if (requests === 3) return { calls: [{ id: 'inspect', name: 'run_remote', arguments: { hostId: 'host', command: 'stat /srv/report-fixture' } }] };
    const text = (callId: string) => fixtureMessageText(request.messages.find((message) => message.tool_call_id === callId)!);
    if (requests === 4) {
      runId = /Operation ID: ([^\n]+)/u.exec(text('script'))![1]!;
      draft = { version: 3, summary: '记录已有脚本输出', checks: [{ kind: 'run-output', operationId: 'missing-source', expectedOutput: '*\n**\n***\n' }] };
      return { calls: [{ id: 'bad-report', name: 'submit_verification', arguments: draft }] };
    }
    if (requests === 5) {
      expect(JSON.parse(text('bad-report'))).toMatchObject({ code: 'verification-source-invalid' });
      draft.checks = [{ kind: 'run-output', operationId: runId, expectedOutput: '*\n**\n***\n' }];
      return { calls: [{ id: 'corrected-report', name: 'submit_verification', arguments: draft }] };
    }
    expect(requests).toBe(6); expect(text('corrected-report')).toContain('Notes recorded');
    return { text: '脚本输出符合已登记预期；目录和影响限制另列，没有重复执行。' };
  });
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: 'report-repair', goal: '创建目录并检查脚本', hostIds: ['host'], localScopes: [], status: 'draft',
    provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const channel: RawTerminal = { close() {}, onData() {}, onClose() {} };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const execute = vi.fn(async (operation: { id: string; command?: string }) => {
    const output = operation.command?.startsWith('python3') ? '*\n**\n***\n' : 'fixture observation';
    return { operationId: operation.id, status: 'succeeded' as const, exitCode: 0, stdoutTail: output,
      outputCapture: { totalChars: output.length, tailChars: output.length, truncated: false } };
  });
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    [], terminal, { execute }, async () => terminal.open('host', channel, task.id, '/srv'), {
      event: (event) => events.push(structuredClone(event)), requestApproval: async () => true, cancelApproval() {}
    });
  try {
    await runner.start(); expect(fixture.errors).toEqual([]); expect(requests).toBe(6);
    expect(execute).toHaveBeenCalledTimes(3);
    const report = events.filter((event) => event.type === 'work-report' && event.report).at(-1);
    expect(report).toMatchObject({ report: { facts: { goals: 'passed', impact: 'not-assessed', operations: expect.any(Array) } } });
    expect(task.report?.facts?.operations).toHaveLength(3);
    expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered', resumeReason: undefined });
  } finally { runner.dispose(); await fixture.close(); }
});
