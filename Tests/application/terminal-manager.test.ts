import { describe, expect, it } from 'vitest';
import type { ProposedOperation, RawTerminal, RawTerminalExecutionContext } from '@cloudhelm/core';
import { CommandNotStartedError, operationFingerprint } from '@cloudhelm/core';
import { TerminalManager } from '../../packages/application/src/terminal-manager.js';

class FakeTerminal implements RawTerminal {
  readonly agent: import('@cloudhelm/core').AgentExecutionPort = this;
  readonly human: import('@cloudhelm/core').HumanTerminalPort = { open() {}, write: (data) => { this.writes.push(data); }, resize() {},
    respondToTerminalQuery: (data) => { this.writes.push(data); return true; } };
  writes: string[] = [];
  closeCount = 0;
  context?: RawTerminalExecutionContext;
  private data?: (text: string) => void;
  private closed?: () => void;
  private exited?: (code: number | undefined) => void;
  commands: Array<{ command: string; cwd: string }> = [];
  async execute(command: string, cwd: string, _current: () => boolean, context?: RawTerminalExecutionContext): Promise<void> {
    this.commands.push({ command, cwd }); this.context = context;
  }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  complete(code = 0): void { this.exited?.(code); }
  confirmInput(_operationId: string, data: 'y\n' | 'n\n'): boolean { this.writes.push(data); return true; }
  interrupt(): boolean { this.writes.push('\u0003'); return true; }
  resize(): void {}
  close(): void { this.closeCount++; this.closed?.(); }
  onData(listener: (text: string) => void): void { this.data = listener; }
  onClose(listener: () => void): void { this.closed = listener; }
  emit(text: string): void { this.data?.(text); }
}

function operation(id: string, generation: number): ProposedOperation {
  return { id, kind: 'command', command: 'echo hi', scope: {
    taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: 'replace', terminalGeneration: generation,
    policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy'
  } };
}

describe('real PTY ownership', () => {
  it.each(['hello', `${'🙂'.repeat(40000)}\n`])('reports authoritative redacted-output truncation without split surrogate pairs', async (output) => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('capture', manager.currentGeneration(id)); proposed.scope.terminalId = id;
    const pending = manager.execute(proposed, operationFingerprint(proposed));
    channel.emit(output); channel.complete();
    const result = await pending;
    expect(result).toMatchObject({ outputCapture: { totalChars: output.length,
      tailChars: result.stdoutTail.length, truncated: output.length > result.stdoutTail.length } });
    expect(result.stdoutTail.length).toBeLessThanOrEqual(16384);
    expect(Buffer.from(result.stdoutTail, 'utf8').toString('utf8')).toBe(result.stdoutTail);
  });

  it('blocks typing until the backend releases the idle session and invalidates old grants', async () => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('one', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    expect(() => manager.input(id, 'pwd\n', true)).toThrow('先停止');
    expect(channel.writes).toEqual([]);
    manager.releaseIdle(id);
    manager.input(id, 'pwd\n', true);
    await expect(manager.execute(proposed, operationFingerprint(proposed))).rejects.toThrow('authorization expired');
    expect(channel.writes).toEqual(['pwd\n']);
  });

  it('runs the original command directly and records the process exit result', async () => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('one', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const result = manager.execute(proposed, operationFingerprint(proposed));
    expect(channel.commands).toEqual([{ command: 'echo hi', cwd: '/srv/app' }]);
    expect(channel.writes).toEqual([]);
    channel.emit('hi\r\n'); channel.complete();
    expect((await result).status).toBe('succeeded');
  });

  it('keeps observing process completion after human takeover', async () => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('takeover', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const running = manager.execute(proposed, operationFingerprint(proposed));
    manager.takeOver(id);
    const handedOver = await running;
    expect(handedOver.status).toBe('handed-over');
    expect(handedOver.remoteCompletion).toBeDefined();
    channel.complete();
    expect(await handedOver.remoteCompletion).toBe('exited');
  });

  it('sends no wrappers or status markers and preserves literal output', async () => {
    const channel = new FakeTerminal();
    const data: Array<{ text: string; operationId?: string }> = [];
    const manager = new TerminalManager({ data(_id, text, operationId) { data.push({ text, operationId }); }, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('clean', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const result = manager.execute(proposed, operationFingerprint(proposed));
    expect(channel.commands).toEqual([{ command: 'echo hi', cwd: '/srv/app' }]);
    expect(channel.writes).toEqual([]);
    channel.emit('hi\r\n'); channel.complete();
    expect((await result).stdoutTail).toBe('hi\r\n');
    expect(data.filter((event) => event.operationId).map((event) => event.text).join('')).toBe('hi\r\n');
    expect(data.map((event) => event.text).join('')).toBe('$ echo hi\r\nhi\r\n');
  });

  it('invalidates a running Agent operation when its terminal is closed', async () => {
    const channel = new FakeTerminal();
    const states: string[] = [];
    const manager = new TerminalManager({ data() {}, state(_id, owner) { states.push(owner); } });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('closing', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const running = manager.execute(proposed, operationFingerprint(proposed));
    manager.close(id);
    const result = await running;
    expect(result.status).toBe('unknown');
    expect(await result.remoteCompletion).toBe('unknown');
    expect(manager.currentGeneration(id)).toBe(-1);
    expect(states).toEqual(['agent', 'suspended', 'closed']);
  });
});

it('passes the reviewed launch plan and its operation/session/generation binding unchanged', async () => {
  const channel = new FakeTerminal(); const manager = new TerminalManager({ data() {}, state() {} });
  const id = manager.open('host', channel, 'task');
  const proposed = operation('reviewed', 1); proposed.scope.terminalId = id; proposed.scope.sessionId = 'root-session';
  if (proposed.kind !== 'command') throw new Error('fixture');
  proposed.executionPlan = { version: 1, shell: 'bash', steps: [{ condition: 'always', argv: ['sudo', '-A', 'id'], runAs: 'root', authentication: 'sudo' }] };
  const result = manager.execute(proposed, operationFingerprint(proposed));
  expect(channel.context).toEqual({ operationId: 'reviewed', sessionId: 'root-session', generation: 1, plan: proposed.executionPlan });
  channel.complete(); await result;
});

it('closes all task terminals across ownership generations, preserving unrelated human terminals', () => {
  const manager = new TerminalManager({ data() {}, state() {} });
  const channels = [new FakeTerminal(), new FakeTerminal(), new FakeTerminal(), new FakeTerminal()];
  const ids = channels.map((channel, i) => manager.open('host', channel, i === 3 ? undefined : 'task'));
  manager.suspend(ids[0]!); manager.takeOver(ids[1]!);
  // Broken adapters must not prevent cleanup of the rest of the task.
  channels[0]!.close = () => { channels[0]!.closeCount++; throw new Error('adapter close failed'); };
  expect(() => manager.closeTask('task')).toThrow('部分任务终端关闭失败');
  expect(ids.slice(0, 3).map((id) => manager.currentGeneration(id))).toEqual([-1, -1, -1]);
  expect(channels.map((channel) => channel.closeCount)).toEqual([1, 1, 1, 0]);
  manager.input(ids[3]!, 'pwd\n', true); expect(channels[3]!.writes).toEqual(['pwd\n']);
  manager.close(ids[3]!);
});

it('does not leave an unresolved operation when preflight confirms no dispatch', async () => {
  const channel = new FakeTerminal();
  channel.execute = async () => { throw new CommandNotStartedError('Python 3 unavailable'); };
  const manager = new TerminalManager({ data() {}, state() {} });
  const id = manager.open('host', channel, 'task');
  const proposed = operation('preflight', manager.currentGeneration(id)); proposed.scope.terminalId = id;
  expect(await manager.execute(proposed, operationFingerprint(proposed))).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'unsupported' });
  expect(manager.pendingOperations('task')).toEqual([]);
});
