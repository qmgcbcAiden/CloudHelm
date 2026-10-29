import { describe, expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { ProposedOperation } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

describe('remote operation serialization', () => {
  it('never overlaps proposals, review and execution when the model batches tool calls', async () => {
    let requests = 0;
    const fixture = await openAiFixture(async () => {
      requests++;
      return requests === 1 ? { calls: [
        { id: 'identity', name: 'run_remote', arguments: { hostId: 'fixture', command: 'id' } },
        { id: 'disk', name: 'run_remote', arguments: { hostId: 'fixture', command: 'df -h' } }
      ] } : { text: '检查完成。' };
    });
    const host: RuntimeHost = { id: 'fixture', label: '本地测试', address: '192.0.2.1', port: 22, username: 'ubuntu',
      auth: 'agent', status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
    const task: TaskView = { id: 'serial-ops', goal: '检查身份和磁盘', hostIds: [host.id], localScopes: [],
      provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 5, createdAt: 1, updatedAt: 1 };
    const terminal = new TerminalManager({ data: () => {}, state: () => {} });
    const terminalId = terminal.open(host.id, { close: () => {}, onData: () => {}, onClose: () => {} }, task.id, '/home/ubuntu');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const finished: string[] = [];
    const execute = vi.fn(async (operation: ProposedOperation) => {
      const command = operation.kind === 'command' ? operation.command : '';
      started.push(command);
      if (command === 'id') await firstGate;
      finished.push(command);
      return { operationId: operation.id, status: 'succeeded' as const, exitCode: 0, effects: 'none' as const, stdoutTail: 'ok' };
    });
    const approvals: string[] = [];
    const events: Parameters<TaskSignals['event']>[0][] = [];
    const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
      [], terminal, { execute }, async () => terminalId, {
        event: (event) => events.push(structuredClone(event)),
        requestApproval: async (approval) => { approvals.push(approval.operationId); return true; },
        cancelApproval: () => {}
      });
    try {
      const run = runner.start();
      await vi.waitFor(() => expect(started).toEqual(['id']), { timeout: 15_000 });
      // The batched second call must not propose, review or execute while the first is in flight.
      expect(execute).toHaveBeenCalledTimes(1);
      expect(approvals).toEqual([]);
      // Every operation event so far belongs to the first command; the second is not proposed yet.
      const visible = events.flatMap((event) => event.type === 'operation' ? [event.value.preview] : []);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((preview) => preview === 'id')).toBe(true);
      releaseFirst();
      await run;
      expect(started).toEqual(['id', 'df -h']);
      expect(finished).toEqual(['id', 'df -h']);
      expect(approvals).toEqual([]);
      expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered' });
    } finally {
      releaseFirst();
      await fixture.close();
    }
  });
});
