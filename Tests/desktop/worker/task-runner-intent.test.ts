import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { OperationExecutor, ProposedOperation, RawTerminal } from '@cloudhelm/core';
import type { TaskIntentState, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

class NoExecutionTerminal implements RawTerminal {
  readonly agent: import('@cloudhelm/core').AgentExecutionPort = this;
  async execute(): Promise<void> { throw new Error('This fixture never dispatches shell commands'); }
  write(): void { throw new Error('This fixture never accepts shell input'); }
  resize(): void {}
  close(): void {}
  onData(): void {}
  onClose(): void {}
}

it('keeps real input and answered clarification in review, then restores the persisted latest intent without UI overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudhelm-intent-'));
  const initial = '只在 /srv/test 部署；禁止触碰 /srv/prod。' + '背景资料。'.repeat(800) + '最新约束：不要重启任何生产服务。';
  const latest = '不要再部署；当前只解释错误，禁止写入或重启。';
  const reviewed: Array<{ goal: { originalGoal: { text: string }; currentInput: { text: string; truncated: boolean }; clarifications: unknown[] } }> = [];
  let count = 0;
  const fixture = await openAiFixture(async (request) => {
    if (request.review) {
      reviewed.push(JSON.parse(fixtureMessageText(request.messages.filter((message) => message.role === 'user').at(-1)!)));
      return { text: JSON.stringify({ verdict: reviewed.length === 1 ? 'allow' : 'deny', reason: 'fixture reviewer decision' }) };
    }
    count++;
    if (count === 1) return { calls: [{ id: 'question', name: 'ask_user', arguments: { questions: [
      { id: 'environment', prompt: '选择部署环境', options: [{ value: 'test', label: '测试环境' }, { value: 'prod', label: '生产环境' }] }
    ] } }] };
    if (count === 2 || count === 5) return { calls: [{ id: `operation-${count}`, name: 'run_remote',
      arguments: { hostId: 'host', command: "bash -c 'touch /srv/test/config'" } }] };
    return { text: '遵守当前限制；没有执行实际远端写入。' };
  });
  const task: TaskView = { id: 'intent-task', goal: '部署应用', hostIds: ['host'], localScopes: [], provider: 'cloudhelm-custom',
    modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 20, createdAt: 1, updatedAt: 1 };
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'ai-review', protectedPaths: [], policyRevision: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const operations: ProposedOperation[] = [];
  const terminal = new TerminalManager({ data() {}, state() {} });
  const executor: OperationExecutor = { execute: async (operation) => {
    operations.push(operation);
    return { operationId: operation.id, status: 'failed', effects: 'none', stdoutTail: 'Synthetic refusal before dispatch' };
  } };
  const make = (view: TaskView, restore: boolean) => new TaskRunner(view, [host],
    { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl }, [], terminal, executor,
    async () => terminal.open(host.id, new NoExecutionTerminal(), task.id, '/srv/test'),
    { event: (event) => events.push(structuredClone(event)), requestApproval: async () => false, cancelApproval() {} },
    undefined, undefined, { id: task.id, directory, restore });
  let runner = make(task, false);
  try {
    const started = runner.start(false, undefined, undefined, initial);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'clarification' && event.value.status === 'pending')).toBe(true), { timeout: 15000 });
    const question = events.find((event) => event.type === 'clarification' && event.value.status === 'pending');
    if (question?.type !== 'clarification') throw new Error('Missing question');
    runner.answerClarification(question.value.id, [{ id: 'environment', value: 'test' }]);
    await started;
    expect(fixture.errors).toEqual([]);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.scope.goal).toContain('禁止触碰 /srv/prod');
    expect(operations[0]?.scope.goal).toContain('测试环境');
    expect(reviewed[0]?.goal.originalGoal.text).toContain('禁止触碰 /srv/prod');
    expect(reviewed[0]?.goal.currentInput.text).toContain('不要重启任何生产服务');
    expect(reviewed[0]?.goal.currentInput.truncated).toBe(true);
    expect(JSON.stringify(reviewed[0]?.goal.clarifications)).toContain('测试环境');
    const projected = events.find((event) => event.type === 'task-message' && event.source === 'clarification');
    expect(projected).toMatchObject({ clarificationToolCallId: 'question', role: 'user' });

    runner.message(latest);
    await vi.waitFor(() => {
      expect(count).toBe(4);
      expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered' });
    }, { timeout: 15000 });
    const update = events.filter((event) => event.type === 'task-intent').at(-1);
    if (update?.type !== 'task-intent') throw new Error('Missing persisted intent event');
    const saved: TaskIntentState = structuredClone(update.value);
    expect(saved).toMatchObject({ originalGoal: initial, currentInput: latest, clarifications: [], origin: 'explicit' });
    runner.dispose();
    const beforeRestore = events.filter((event) => event.type === 'task-intent').length;
    runner = make({ ...task, intent: saved, status: 'failed', resumeReason: 'model' }, true);
    await runner.start(true);
    expect(count).toBe(4);
    expect(events.filter((event) => event.type === 'task-intent')).toHaveLength(beforeRestore);
    await runner.resume();
    expect(fixture.errors).toEqual([]);
    expect(reviewed).toHaveLength(2);
    expect(reviewed[1]?.goal.currentInput.text).toBe(latest);
    expect(reviewed[1]?.goal.clarifications).toEqual([]);
    expect(operations).toHaveLength(1); // Current explicit no-write intent was visible to review.
  } finally { runner.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
