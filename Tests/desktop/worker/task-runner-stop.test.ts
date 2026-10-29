import { describe, expect, it, vi } from 'vitest';
import { HostSerialExecutor, InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import type { SshTransport } from '@cloudhelm/adapters';
import type { ExecutionOptions, ProposedOperation } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { OperationInputBridge } from '../../../apps/desktop/src/worker/operation-input-bridge.js';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

describe('backend enforcement of stopped remote work', () => {
  it.each(['credential-command', 'human-review'] as const)(
    'blocks tool switching and terminal replacement after %s rejects an operation', async (cause) => {
      let requests = 0;
      const fixture = await openAiFixture(async (request) => {
        if (request.review) return { text: '{"verdict":"deny","reason":"unsafe"}' };
        requests++;
        if (requests > 1) throw new Error('The agent must stop rather than plan a workaround');
        return { calls: [
          { id: 'first', name: 'run_remote', arguments: { hostId: 'fixture', command: cause === 'credential-command'
            ? 'sudo -S cat /root/test/test' : 'python3 -c "print(1)"' } },
          // Another reviewed command in the same batch must be stopped as well.
          { id: 'fallback', name: 'run_remote', arguments: { hostId: 'fixture', command: 'sudo cat /root/test/test' } }
        ] };
      });
      const host: RuntimeHost = { id: 'fixture', label: '测试', address: '192.0.2.1', port: 22, username: 'ubuntu',
        auth: 'agent', status: 'connected', defaultMode: 'ask',
        protectedPaths: [], policyRevision: 1 };
      const task: TaskView = { id: 'stop-test', goal: '检查/root/test/test', hostIds: [host.id], localScopes: [],
        provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 5, createdAt: 1, updatedAt: 1 };
      const events: Parameters<TaskSignals['event']>[0][] = [];
      const terminal = new TerminalManager({ data() {}, state() {} });
      const write = vi.fn(() => { throw new Error('No real SSH writes'); });
      const openTerminal = vi.fn(async () => terminal.open(host.id,
        { human: { open() {}, write, resize() {} }, close() {}, onData() {}, onClose() {} }, task.id, '/home/ubuntu'));
      const coordinator = new InteractionCoordinator(terminal, { opened() {}, closed() {} });
      const ssh = { connectionGeneration: () => 1 } as unknown as SshTransport;
      const bridge = new OperationInputBridge(terminal, ssh, coordinator);
      const execute = vi.fn(async (operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions) => {
        expect(operation.kind).toBe('command');
        return bridge.execute(operation, fingerprint, signal, options);
      });
      const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
        [], terminal, new HostSerialExecutor({ execute }), openTerminal,
        { event: (event) => events.push(structuredClone(event)), requestApproval: async () => false, cancelApproval() {} });
      try {
        await runner.start();
        expect(fixture.errors).toEqual([]);
        expect(requests).toBe(1);
        expect(execute).not.toHaveBeenCalled();
        expect(openTerminal).toHaveBeenCalledTimes(1);
        expect(write).not.toHaveBeenCalled();
        const statuses = events.filter((event) => event.type === 'task-status');
        expect(statuses.at(-1)).toMatchObject({ status: 'paused' });
        expect(JSON.stringify(statuses)).toContain('审核未放行');
      } finally { await fixture.close(); }
    }
  );
});
