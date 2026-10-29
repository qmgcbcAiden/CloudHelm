import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { ProposedOperation } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

it.each(['allow', 'deny'] as const)('binds compound sudo replay protection to the final audited identities (%s)', async (verdict) => {
  const command = 'sudo /usr/local/bin/fixture; /usr/local/bin/fixture; sudo -u postgres /usr/local/bin/fixture';
  let turns = 0; let reviews = 0;
  const fixture = await openAiFixture(async (request) => {
    if (request.review) { reviews++; return { text: JSON.stringify({ verdict, reason: 'Bounded fixture review' }) }; }
    turns++;
    if (turns <= 2) return { calls: [{ id: `attempt-${turns}`, name: 'run_remote', arguments: { hostId: 'host', command } }] };
    const repeat = request.messages.find((message) => message.tool_call_id === 'attempt-2');
    expect(fixtureMessageText(repeat!)).toContain(verdict === 'deny' ? 'prior-review-denied' : 'replay-protected');
    return { text: '没有重放已处理的操作。' };
  });
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'deploy', auth: 'agent',
    status: 'connected', defaultMode: 'ai-review', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: `compound-sudo-${verdict}`, goal: '运行指定的测试操作', hostIds: ['host'], localScopes: [],
    status: 'draft', provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const operations = new Map<string, OperationView>();
  const execute = vi.fn(async (operation: ProposedOperation) => ({ operationId: operation.id, status: 'succeeded' as const,
    stdoutTail: 'fixture completed', exitCode: 0 }));
  const requestApproval = vi.fn(async () => { throw new Error('Independent AI review should settle the fixture'); });
  const event: TaskSignals['event'] = (value) => { if (value.type === 'operation') operations.set(value.value.id, structuredClone(value.value)); };
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture', baseUrl: fixture.baseUrl }, [],
    terminal, { execute }, async () => terminal.open(host.id, { close() {}, onData() {}, onClose() {} }, task.id, '/srv'),
    { event, requestApproval, cancelApproval() {} });
  try {
    await runner.start();
    expect(fixture.errors).toEqual([]); expect(turns).toBe(3); expect(reviews).toBe(1);
    expect(requestApproval).not.toHaveBeenCalled(); expect(operations.size).toBe(1);
    expect([...operations.values()][0]).toMatchObject({ runAs: 'root → deploy → postgres', status: verdict === 'allow' ? 'succeeded' : 'denied' });
    expect(execute).toHaveBeenCalledTimes(verdict === 'allow' ? 1 : 0);
    if (verdict === 'allow') expect(execute.mock.calls[0]![0]).toMatchObject({
      scope: { loginAs: 'deploy', runAs: 'root → deploy → postgres' },
      executionPlan: { steps: [{ runAs: 'root' }, { runAs: 'deploy' }, { runAs: 'postgres' }] }
    });
  } finally { runner.dispose(); await fixture.close(); }
});
