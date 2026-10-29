import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { OperationExecutor, RawTerminal } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

const expectedOutput = '    *\n   ***\n  *****\n *******\n*********\n';
const content = 'for i in range(1, 6):\n    print(" " * (5 - i) + "*" * (2 * i - 1))\n';
it.each(['implicit', 'declared', 'wrong', 'truncated'] as const)('handles the actual staged sudo workflow with %s output verification and no submit_verification', async (mode) => {
  let requests = 0;
  const expectation = mode === 'implicit' ? {} : { outputExpectation: { expectedOutput } };
  const fixture = await openAiFixture(async () => {
    requests++;
    const steps = [
      { name: 'run_remote', arguments: { hostId: 'host', command: 'sudo -- mkdir -p /root/test', cwd: '/tmp' } },
      { name: 'write_remote_file', arguments: { hostId: 'host', path: '/tmp/test.py', content, cwd: '/tmp' } },
      { name: 'run_remote', arguments: { hostId: 'host', command: 'sudo -- install -m 0644 /tmp/test.py /root/test/test.py', cwd: '/tmp' } },
      { name: 'run_remote', arguments: { hostId: 'host', command: 'sudo -- python3 /root/test/test.py', cwd: '/root/test', ...expectation } },
      { name: 'run_remote', arguments: { hostId: 'host', command: 'sudo -- python3 /root/test/test.py', cwd: '/tmp', ...expectation } },
      { name: 'run_remote', arguments: { hostId: 'host', command: 'sudo -- ls -l /root/test', cwd: '/tmp' } },
      { name: 'delete_remote_file', arguments: { hostId: 'host', path: '/tmp/test.py', cwd: '/tmp' } }
    ];
    const step = steps[requests - 1];
    return step ? { calls: [{ id: `step-${requests}`, ...step }] } : { text: '根据实际运行输出说明结果；没有执行文件内容读回，不将 ls 当成内容校验。' };
  });
  const view: TaskView = { id: 'user-workflow', goal: '在/root/test创建test.py并运行打印星号三角形', hostIds: ['host'], localScopes: [], status: 'draft',
    provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 };
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const channel: RawTerminal = { close() {}, onData() {}, onClose() {} };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const operations = new Map<string, OperationView>();
  const execute = vi.fn<OperationExecutor['execute']>(async (operation) => {
    const notStarted = operation.kind === 'command' && operation.command.includes('python3') && operation.scope.cwd === '/root/test';
    const run = operation.kind === 'command' && operation.command.includes('python3') && !notStarted;
    const output = notStarted ? '命令未启动：所需工具或工作目录不存在。' : run ? mode === 'wrong' ? 'wrong\n' : expectedOutput : '';
    return { operationId: operation.id, status: notStarted ? 'failed' : 'succeeded', exitCode: notStarted ? 127 : 0,
      effects: notStarted ? 'none' : undefined, failureKind: notStarted ? 'unsupported' : undefined, stdoutTail: output,
      outputCapture: { totalChars: output.length, tailChars: output.length, truncated: run && mode === 'truncated' } };
  });
  const runner = new TaskRunner(view, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    [], terminal, { execute }, async () => terminal.open(host.id, channel, view.id, '/tmp'),
    { event(event) { if (event.type === 'operation') operations.set(event.value.id, structuredClone(event.value)); },
      requestApproval: async () => true, cancelApproval() {} });
  try {
    await runner.start(); expect(fixture.errors).toEqual([]); expect(requests).toBe(8); expect(execute).toHaveBeenCalledTimes(7);
    expect(view.status).toBe('answered'); expect(view.resumeReason).toBeUndefined();
    expect([...operations.values()].filter((op) => op.status === 'failed')).toHaveLength(1);
    expect(view.report?.facts).toMatchObject({ registration: 'automatic', execution: 'succeeded-after-retry',
      goals: mode === 'implicit' ? 'execution-observed' : mode === 'declared' ? 'passed' : mode === 'wrong' ? 'failed' : 'inconclusive' });
    expect(view.report?.facts?.recoveredAttemptIds).toHaveLength(1);
    expect(view.report?.goalChecks).toHaveLength(1);
    expect(view.report?.goalChecks?.[0]).toMatchObject({ kind: mode === 'implicit' ? 'run-completion' : 'run-output',
      status: mode === 'wrong' ? 'failed' : mode === 'truncated' ? 'inconclusive' : 'passed' });
    expect(view.report?.goalChecks?.some((check) => check.kind === 'file-content')).toBe(false);
    expect(view.report?.changes.some((change) => change.includes('/root/test/test.py'))).toBe(true);
    expect(fixture.requests.flatMap((request) => request.messages).some((message) => message.tool_call_id === 'submit_verification')).toBe(false);
  } finally { runner.dispose(); await fixture.close(); }
});
