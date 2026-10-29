import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

it('retries the post-tool HTTP request without repeating the completed remote action', async () => {
  let requests = 0;
  const fixture = await openAiFixture(async () => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'disk', name: 'run_remote', arguments: { hostId: 'host', command: 'df -h' } }] };
    if (requests === 2) return { error: 'temporary gateway outage', status: 502 };
    return { text: '已有磁盘观察结果，无需重复执行。' };
  });
  const task: TaskView = { id: 'retry-task', goal: '检查磁盘', hostIds: ['host'], localScopes: [], modelId: 'fixture',
    status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const execute = vi.fn(async (operation: { id: string }) => ({ operationId: operation.id, status: 'succeeded' as const,
    stdoutTail: 'disk observation', exitCode: 0, effects: 'none' as const }));
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl }, [],
    terminal, { execute }, async () => terminal.open(host.id, { close() {}, onData() {}, onClose() {} }, task.id, '/tmp'),
    { event: (event) => events.push(event), requestApproval: async () => false, cancelApproval() {} });
  try {
    await runner.start();
    expect(fixture.errors).toEqual([]); expect(execute).toHaveBeenCalledOnce(); expect(requests).toBe(3);
    expect(fixture.requests[1]).toEqual(fixture.requests[2]);
    expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered', requestCount: 3 });
  } finally { runner.dispose(); await fixture.close(); }
});
