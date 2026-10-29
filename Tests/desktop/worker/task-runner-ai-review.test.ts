import { describe, expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { ProposedOperation } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

describe('AI denial manual review', () => {
  it('rebinds a completed conversation to a new terminal and asks for one exact operation', async () => {
    let turns = 0;
    let reviews = 0;
    const fixture = await openAiFixture(async (request) => {
      if (request.review) { reviews++; return { text: '{"verdict":"deny","reason":"Unclear script effect"}' }; }
      turns++;
      return turns <= 2 || turns === 4
        ? { calls: [{ id: `opaque-${turns}`, name: 'run_remote', arguments: { hostId: 'host',
          command: turns === 4 ? 'python3 -c "print(2)"' : 'python3 -c "print(1)"' } }] }
        : { text: '审核拒绝，原操作未执行。' };
    });
    const host: RuntimeHost = { id: 'host', label: '测试主机', address: '192.0.2.1', port: 22,
      username: 'deploy', auth: 'agent', status: 'connected', defaultMode: 'ai-review',
      protectedPaths: [], policyRevision: 1 };
    const task: TaskView = { id: 'review-task', goal: 'Run a script', hostIds: ['host'], localScopes: [],
      provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0,
      requestLimit: 10, createdAt: 1, updatedAt: 1, reviewModesByHost: { host: 'ai-review' }, reviewRevision: 1 };
    const terminal = new TerminalManager({ data() {}, state() {} });
    const opened: string[] = [];
    const openTerminal = vi.fn(async () => {
      const id = terminal.open(host.id, { close() {}, onData() {}, onClose() {} }, task.id, '/srv/app');
      opened.push(id);
      return id;
    });
    const events: Parameters<TaskSignals['event']>[0][] = [];
    const execute = vi.fn(async (operation: ProposedOperation) => ({ operationId: operation.id,
      status: 'succeeded' as const, stdoutTail: '', exitCode: 0 }));
    const requestApproval = vi.fn(async () => true);
    const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture',
      apiKey: 'test-key', baseUrl: fixture.baseUrl, reviewer: { selection: { kind: 'model', provider: 'cloudhelm-custom', modelId: 'auditor' },
        provider: 'cloudhelm-custom', modelId: 'auditor', apiKey: 'test-key', baseUrl: fixture.baseUrl, revision: 1 } },
    [], terminal, { execute }, openTerminal,
    { event: (event) => events.push(structuredClone(event)), requestApproval, cancelApproval() {} });
    try {
      await runner.start();
      const denied = events.filter((event) => event.type === 'operation' && event.value.ruleId === 'ai-review-deny').at(-1);
      expect(denied).toMatchObject({ type: 'operation', value: { manualReviewAvailable: true, status: 'denied' } });
      if (!denied || denied.type !== 'operation') throw new Error('Missing denial');
      expect(execute).not.toHaveBeenCalled();
      expect(reviews).toBe(1);
      expect(fixture.requests.find((request) => request.review)?.model).toBe('auditor');
      expect(terminal.isAgentOwner(opened[0]!)).toBe(false);
      await runner.requestAiDenialReview(denied.value.id);
      expect(openTerminal).toHaveBeenCalledTimes(2);
      expect(requestApproval).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]![0]).toMatchObject({ command: 'python3 -c "print(1)"',
        scope: { terminalId: opened[1], terminalGeneration: terminal.currentGeneration(opened[1]!) - 1 } });
      expect(execute.mock.calls[0]![0].id).not.toBe(denied.value.id);
      await expect(runner.requestAiDenialReview(denied.value.id)).rejects.toThrow('不可复核');
      runner.setReviewProfile({ selection: { kind: 'model', provider: 'cloudhelm-custom', modelId: 'auditor-2' },
        provider: 'cloudhelm-custom', modelId: 'auditor-2', apiKey: 'test-key', baseUrl: fixture.baseUrl, revision: 2 });
      runner.message('检查另一条命令');
      await vi.waitFor(() => expect(reviews).toBe(2), { timeout: 15_000 });
      expect(fixture.requests.filter((request) => request.review).at(-1)?.model).toBe('auditor-2');
    } finally { runner.pause(); await fixture.close(); }
  });
});
