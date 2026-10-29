import { expect, it, vi } from 'vitest';
import { HostSerialExecutor, PermissionAwareExecutor, TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer } from '@cloudhelm/adapters';
import type { RawTerminal } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';
class DiagnosticTerminal implements RawTerminal {
  readonly agent: import('@cloudhelm/core').AgentExecutionPort = this;
  commands: string[] = [];
  private exit?: (code: number | undefined) => void;
  private data?: (text: string) => void;
  constructor(private readonly unknown: boolean) {}
  async execute(command: string) {
    this.commands.push(command);
    queueMicrotask(() => { this.data?.('10 packets transmitted, 0 received, 100% packet loss\n'); this.exit?.(this.unknown ? undefined : 1); });
  }
  onExit(fn: (code: number | undefined) => void) { this.exit = fn; }
  onData(fn: (text: string) => void) { this.data = fn; }
  write(): void { throw new Error('No real shell input permitted'); }
  close() {} resize() {} onClose() {}
}
it.each([false, true])('keeps bounded ping failure separate from a possible mutation; unknown exit remains a stop (%s)', async (unknown) => {
  let count = 0;
  const command = 'ping -c 10 -W 2 192.0.2.1';
  const fixture = await openAiFixture(async (request) => {
    if (request.review) throw new Error('Exact human approval should be retained');
    if (++count === 1) return { calls: [{ id: 'ping', name: 'run_remote', arguments: { hostId: 'host', command } }] };
    if (unknown) throw new Error('Unknown exit must not continue');
    const output = fixtureMessageText(request.messages.find((message) => message.tool_call_id === 'ping')!);
    expect(output).toContain('Effects: none'); expect(output).toContain('no prior-effects verification is needed');
    return { text: '这次有界 ICMP 采样未收到回应；不能据此判断其他协议是否可达，也不能断言原因。' };
  });
  const task: TaskView = { id: 'ping-fixture', goal: '采样检查 ICMP 连通性', hostIds: ['host'], localScopes: [], status: 'draft',
    provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 };
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.10', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const terminal = new TerminalManager({ data() {}, state() {}, completed: (result) => runner.recordRemoteResult(result) });
  const channel = new DiagnosticTerminal(unknown); const terminalId = terminal.open(host.id, channel, task.id, '/home/user');
  const approve = vi.fn(async () => true);
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    [], terminal, new HostSerialExecutor(new PermissionAwareExecutor(terminal, new BashAnalyzer())), async () => terminalId,
    { event: (event) => events.push(structuredClone(event)), requestApproval: approve, cancelApproval() {} });
  try {
    await runner.start(); expect(fixture.errors).toEqual([]); expect(channel.commands).toEqual([command]);
    expect(approve).toHaveBeenCalledOnce(); expect(approve.mock.calls[0]).toEqual([expect.objectContaining({ preview: command })]);
    const final = events.filter((event) => event.type === 'task-status').at(-1);
    const ops = new Map<string, OperationView>(); for (const event of events) if (event.type === 'operation') ops.set(event.value.id, event.value);
    if (unknown) {
      expect(count).toBe(1); expect(final).toMatchObject({ status: 'paused' });
      expect([...ops.values()][0]?.effects).not.toBe('none');
    } else {
      expect(count).toBe(2); expect(final).toMatchObject({ status: 'answered', resumeReason: undefined, summary: undefined });
      expect([...ops.values()][0]).toMatchObject({ readOnly: true, status: 'failed', exitCode: 1, effects: 'none' });
      expect(events.some((event) => event.type === 'verification-state' && event.value)).toBe(false);
      await expect(runner.resume()).rejects.toThrow('没有可自动继续');
    }
  } finally { runner.dispose(); await fixture.close(); }
});
