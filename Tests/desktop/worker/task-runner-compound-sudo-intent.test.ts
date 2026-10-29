import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

it.each(['succeeded', 'denied'] as const)('restores a v11 compound sudo %s barrier without rewriting history or minting a new approval', async (status) => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudhelm-legacy-sudo-'));
  const command = 'sudo /usr/local/bin/fixture; /usr/local/bin/fixture; sudo -u postgres /usr/local/bin/fixture';
  let seeded = false; let turns = 0;
  const fixture = await openAiFixture(async (request) => {
    if (request.review) throw new Error('A historical barrier must block before another review');
    if (!seeded) { seeded = true; return { text: '保留既有操作记录，恢复后不能重放。' }; }
    turns++;
    if (turns === 1) return { calls: [{ id: 'new-tool-call-id', name: 'run_remote', arguments: { hostId: 'host', command } }] };
    const feedback = fixtureMessageText(request.messages.find((message) => message.tool_call_id === 'new-tool-call-id')!);
    expect(feedback).toContain(status === 'denied' ? 'prior-review-denied' : 'replay-protected');
    expect(feedback).toContain('legacy-compound');
    return { text: '历史操作已阻止重放，没有新授权或执行。' };
  });
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'deploy', auth: 'agent',
    status: 'connected', defaultMode: 'ai-review', protectedPaths: [], policyRevision: 5 };
  const task: TaskView = { id: `legacy-compound-${status}`, goal: '检查既有操作', hostIds: ['host'], localScopes: [],
    status: 'draft', provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  // Generated by running the unmodified 34d8ce8 fingerprint code with the old compound runAs=deploy.
  const original: OperationView = { id: 'legacy-compound', taskId: task.id, hostId: host.id, kind: 'command', preview: command,
    intentKey: 'fc3bcfd8171ddcd96704a508fd7113ba0188958280fb1f7c9b251682626b0ab2', loginAs: 'deploy', runAs: 'deploy',
    status, ruleId: status === 'denied' ? 'ai-review-deny' : 'ai-review-allow', readOnly: false, createdAt: 1,
    ...(status === 'succeeded' ? { exitCode: 0, exitObserved: true, completedAt: 2 } : {}) };
  const historical = structuredClone(original); const operations: OperationView[] = [];
  const terminal = new TerminalManager({ data() {}, state() {} });
  const execute = vi.fn(async (operation: ProposedOperation) => ({ operationId: operation.id, status: 'succeeded' as const,
    stdoutTail: '', exitCode: 0 }));
  const requestApproval = vi.fn(async () => true);
  const make = (restore: boolean) => new TaskRunner(task, [host],
    { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture', baseUrl: fixture.baseUrl }, [original],
    terminal, { execute }, async () => terminal.open(host.id, { close() {}, onData() {}, onClose() {} }, task.id, '/srv'),
    { event: (event) => { if (event.type === 'operation') operations.push(structuredClone(event.value)); }, requestApproval, cancelApproval() {} },
    undefined, undefined, { id: task.id, directory, restore });
  let runner = make(false);
  try {
    await runner.start(); expect(fixture.errors).toEqual([]); expect(fixture.requests).toHaveLength(1);
    runner.dispose(); task.status = 'paused'; task.resumeReason = 'model';
    runner = make(true); await runner.start(true);
    expect(fixture.requests).toHaveLength(1); operations.length = 0;
    await runner.resume();
    expect(fixture.errors).toEqual([]); expect(turns).toBe(2);
    expect(execute).not.toHaveBeenCalled(); expect(requestApproval).not.toHaveBeenCalled();
    expect(operations).toEqual([]); expect(original).toEqual(historical);
  } finally { runner.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
