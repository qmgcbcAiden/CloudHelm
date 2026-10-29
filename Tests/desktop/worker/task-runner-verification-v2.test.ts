import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalManager } from '@cloudhelm/application';
import type { RawTerminal } from '@cloudhelm/core';
import type { OperationView, TaskView, VerificationSubmissionV3 } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';
const channel: RawTerminal = { close() {}, onData() {}, onClose() {} };
it.each(['passed', 'failed', 'inconclusive'] as const)('records %s checks through native tools and finishes honestly without repeating changes', async (status) => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudhelm-v2-report-'));
  let requests = 0;
  const fixture = await openAiFixture(async (request) => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'create', name: 'run_remote', arguments: { hostId: 'host', command: 'mkdir -p /srv/report-fixture' } }] };
    if (requests === 2) return { calls: [{ id: 'inspect', name: 'run_remote', arguments: { hostId: 'host', command: 'stat /srv/report-fixture' } }] };
    if (requests === 3) {
      const id = (callId: string) => /Operation ID: ([^\n]+)/u.exec(fixtureMessageText(request.messages.find((message) => message.tool_call_id === callId)!))![1]!;
      const check: NonNullable<VerificationSubmissionV3['checks']>[number] = { kind: 'model-assessment', target: '目录状态', expected: '目录存在',
        observed: status === 'passed' ? 'stat成功返回' : '本次stat未取得符合目标的结果', evidenceOperationId: id('inspect'), status };
      return { calls: [{ id: 'report', name: 'submit_verification', arguments: { version: 3, summary: '如实登记目录检查，不证明其他业务目标',
        recovery: ['按审核后单独处理，未自动执行恢复'], checks: [check] } }] };
    }
    return { text: status === 'passed' ? '目录检查通过，不代表应用健康。' : '检查未全部通过，不声称目标已完成，也不重复写入。' };
  });
  const task: TaskView = { id: 'report-fixture', goal: '创建目录并检查', hostIds: ['host'], localScopes: [], status: 'draft',
    modelId: 'fixture', provider: 'cloudhelm-custom', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 };
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const profile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const terminal = new TerminalManager({ data() {}, state() {} });
  const execute = vi.fn(async (operation: { id: string; command?: string }) => ({ operationId: operation.id,
    status: operation.command?.startsWith('stat') && status !== 'passed' ? 'failed' as const : 'succeeded' as const,
    exitCode: operation.command?.startsWith('stat') && status !== 'passed' ? 1 : 0, stdoutTail: 'fixture observation' }));
  const make = (view: TaskView, prior: OperationView[] = [], restore = false) => new TaskRunner(view, [host], profile, prior, terminal, { execute },
    async () => terminal.open('host', channel, task.id, '/srv'),
    { event: (event) => events.push(structuredClone(event)), requestApproval: async () => true, cancelApproval() {} },
    undefined, undefined, { id: task.id, directory, restore });
  let runner = make(task);
  try {
    await runner.start(); expect(fixture.errors).toEqual([]); expect(requests).toBe(4); expect(execute).toHaveBeenCalledTimes(2);
    const report = events.filter((event) => event.type === 'work-report' && event.report).at(-1);
    expect(report).toMatchObject({ report: { version: 3, goalChecks: expect.arrayContaining([expect.objectContaining({ status, authority: 'model' })]) } });
    const verification = events.filter((event) => event.type === 'verification-state').at(-1);
    expect(verification).toMatchObject({ value: { status: 'unverified' } });
    expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered', resumeReason: undefined });
    await expect(runner.resume()).rejects.toThrow('没有可自动继续'); expect(requests).toBe(4);
    if (status !== 'passed') {
      const indexed = new Map<string, OperationView>(); for (const event of events) if (event.type === 'operation') indexed.set(event.value.id, event.value);
      const file = join(directory, (await readdir(directory)).find((name) => name.endsWith('.jsonl'))!);
      const beforeRestore = await readFile(file, 'utf8');
      runner.dispose();
      runner = make(structuredClone(task), [...indexed.values()], true); await runner.start(true);
      await expect(runner.resume()).rejects.toThrow('没有可自动继续'); expect(requests).toBe(4);
      runner.message('现在仅解释检查限制，不要重复变更');
      await vi.waitFor(() => expect({ requests, failure: events.filter((event) => event.type === 'task-status').at(-1)?.summary })
        .toEqual({ requests: 5, failure: undefined }), { timeout: 15000 });
      await vi.waitFor(() => expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered' }));
      expect(execute).toHaveBeenCalledTimes(2);
      expect(events.filter((event) => event.type === 'verification-state').at(-1)).toMatchObject({ value: undefined });
      expect((await readFile(file, 'utf8')).startsWith(beforeRestore)).toBe(true);
    }
  } finally { runner.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
