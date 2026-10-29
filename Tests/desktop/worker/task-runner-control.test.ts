import { describe, expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { RawTerminal } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlTerminal implements RawTerminal {
  readonly agent: import('@cloudhelm/core').AgentExecutionPort = this;
  readonly human: import('@cloudhelm/core').HumanTerminalPort = { open() {}, write: (data) => { this.writes.push(data); }, resize() {} };
  private exited?: (code: number) => void;
  private closed?: () => void;
  commands: string[] = [];
  writes: string[] = [];
  constructor(private readonly completeImmediately: boolean) {}
  async execute(command: string): Promise<void> {
    this.commands.push(command);
    if (this.completeImmediately) queueMicrotask(() => this.complete());
  }
  complete(): void { this.exited?.(0); }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  interrupt(): boolean { this.writes.push('\u0003'); return true; }
  resize(): void {}
  close(): void { this.closed?.(); }
  onData(): void {}
  onClose(listener: () => void): void { this.closed = listener; }
}

async function setup(completeImmediately = true, command = 'df -h', repeat = false) {
  const control: { openBarrier?: Promise<void>; responseBarrier?: Promise<void>; failResponse?: boolean; replayNext?: boolean } = {};
  let requests = 0;
  const fixture = await openAiFixture(async () => {
    requests++;
    if (requests === 1 || (repeat && requests === 2) || control.replayNext) {
      control.replayNext = false;
      return { calls: [{ id: `disk-${requests}`, name: 'run_remote', arguments: { hostId: 'host', command } }] };
    }
    if (control.failResponse) return { error: 'model network failed after successful operation', status: 500 };
    await control.responseBarrier;
    return { text: '已经核验当前状态。' };
  });
  const host: RuntimeHost = { id: 'host', label: '测试主机', address: '192.0.2.1', port: 22, username: 'ubuntu', auth: 'agent',
    status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: 'control-test', goal: '检查磁盘占用', hostIds: [host.id], localScopes: [], provider: 'cloudhelm-custom',
    modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const terminal = new TerminalManager({ data() {}, state() {}, completed: (result) => runner.recordRemoteResult(result) });
  const sessions: Array<{ id: string; channel: ControlTerminal }> = [];
  const openTerminal = vi.fn(async () => {
    const channel = new ControlTerminal(completeImmediately);
    const id = terminal.open(host.id, channel, task.id, '/home/ubuntu');
    sessions.push({ id, channel });
    await control.openBarrier;
    return id;
  });
  const clearCredentials = vi.fn();
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
    [], terminal, terminal, openTerminal,
    { clearCredentials, event: (event) => events.push(structuredClone(event)), requestApproval: async () => false, cancelApproval() {} });
  return { clearCredentials, runner, terminal, sessions, events, openTerminal, control, fixture, requests: () => requests };
}

describe('stop and explicit continuation', () => {
  it('finishes a diagnostic answer without offering a phantom continuation', async () => {
    const f = await setup();
    try {
      await f.runner.start();
      expect(f.events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered' });
      await expect(f.runner.resume()).rejects.toThrow('没有可自动继续');
      expect(f.requests()).toBe(2);
    } finally { await f.fixture.close(); }
  });

  it('automatically records a completed change without forcing a report continuation or replay', async () => {
    const f = await setup(true, 'mkdir -p /srv/service');
    try {
      await f.runner.start();
      expect(f.events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered', resumeReason: undefined });
      expect(f.events.filter((event) => event.type === 'verification-state').at(-1)).toMatchObject({ value: { status: 'unverified', reasonCode: 'goals-not-checked' } });
      expect(f.events.filter((event) => event.type === 'work-report').at(-1)).toMatchObject({ report: { facts: { registration: 'automatic', goals: 'not-checked' } } });
      await expect(f.runner.resume()).rejects.toThrow('没有可自动继续');
      expect(f.requests()).toBe(2);
      expect(f.sessions.flatMap((session) => session.channel.commands)).toEqual(['mkdir -p /srv/service']);
      expect(f.events.filter((event) => event.type === 'task-message' && event.role === 'user')).toHaveLength(1);
    } finally { await f.fixture.close(); }
  });
  it('preserves successful changes when a subsequent model request fails and the user continues', async () => {
    const f = await setup(true, 'mkdir -p /srv/service');
    try {
      f.control.failResponse = true;
      await f.runner.start();
      expect(f.requests()).toBe(2);
      expect(f.events.some((event) => event.type === 'verification-state' && event.value?.status === 'unverified')).toBe(true);
      f.control.failResponse = false; f.control.replayNext = true;
      f.runner.message('继续检查原结果');
      await vi.waitFor(() => expect(f.requests()).toBe(4), { timeout: 15_000 });
      expect(f.sessions.flatMap((session) => session.channel.commands)).toEqual(['mkdir -p /srv/service']);
      expect(JSON.stringify(f.fixture.requests[2]?.messages)).toContain('CloudHelm resume:');
      expect(JSON.stringify(f.fixture.requests[3]?.messages)).toContain('already records this action');
    } finally { f.runner.pause(); await f.fixture.close(); }
  });

  it('does not execute the same successful change twice when the model repeats it with a new call id', async () => {
    const f = await setup(true, 'mkdir -p /srv/service', true);
    try {
      await f.runner.start();
      expect(f.sessions.flatMap((session) => session.channel.commands)).toEqual(['mkdir -p /srv/service']);
      expect(JSON.stringify(f.fixture.requests.at(-1)?.messages)).toContain('already records this action');
    } finally { f.runner.pause(); await f.fixture.close(); }
  });

  it('does not replay a succeeded mutation after an unverified answer when the user sends a follow-up', async () => {
    const f = await setup(true, 'mkdir -p /srv/service');
    try {
      await f.runner.start();
      f.control.replayNext = true;
      f.runner.message('继续检查原变更');
      await vi.waitFor(() => expect(f.requests()).toBe(4), { timeout: 15_000 });
      expect(f.sessions.flatMap((session) => session.channel.commands)).toEqual(['mkdir -p /srv/service']);
      expect(JSON.stringify(f.fixture.requests[3]?.messages)).toContain('already records this action');
    } finally { f.runner.pause(); await f.fixture.close(); }
  });

  it('keeps a disconnected command unknown after model abort and never claims it exited', async () => {
    const f = await setup(false);
    try {
      const running = f.runner.start();
      await vi.waitFor(() => expect(f.sessions[0]?.channel.commands).toHaveLength(1), { timeout: 15_000 });
      f.runner.stopOperation(); await running;
      f.sessions[0]!.channel.close();
      expect(f.events.filter((event) => event.type === 'execution').at(-1)).toMatchObject({ value: { model: 'idle', remote: 'unknown', stopping: false, canStop: false } });
      expect(f.events.filter((event) => event.type === 'operation').at(-1)).toMatchObject({ value: { status: 'unknown' } });
    } finally { f.runner.pause(); await f.fixture.close(); }
  });

  it('permits idle terminal input without prompting and ignores stale stop actions after completion', async () => {
    const f = await setup();
    try {
      await f.runner.start();
      expect(f.clearCredentials).toHaveBeenCalled();
      const id = f.sessions[0]!.id;
      f.runner.terminalInput(id, 'pwd\n');
      f.runner.stopOperation();
      expect(f.requests()).toBe(2);
      expect(f.sessions[0]!.channel.writes).toEqual(['pwd\n']);
      expect(f.events.filter((event) => event.type === 'task-message' && event.interruption)).toHaveLength(0);
      expect(f.terminal.isAgentOwner(id)).toBe(false);
    } finally { await f.fixture.close(); }
  });

  it.each(['ctrl-c', 'stop-button', 'terminal-close'] as const)('records %s as user intent, blocks input while running, and reports it only on the next explicit turn', async (source) => {
    const f = await setup(false);
    try {
      const running = f.runner.start();
      await vi.waitFor(() => expect(f.sessions[0]?.channel.commands).toEqual(['df -h']), { timeout: 15000 });
      const id = f.sessions[0]!.id;
      expect(() => f.runner.terminalInput(id, 'pwd\n')).toThrow('先停止');
      expect(f.sessions[0]!.channel.writes).toEqual([]);
      if (source === 'ctrl-c') f.runner.terminalInput(id, '\u0003'); else f.runner.stopOperation(source);
      f.runner.stopOperation(source); // Repeated clicks cannot inject duplicate controls or requests.
      await running;
      expect(f.events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'paused', resumeReason: 'interrupted' });
      expect(f.clearCredentials).toHaveBeenCalled();
      expect(f.events.filter((event) => event.type === 'execution').at(-1)).toMatchObject({ value: { model: 'idle', remote: 'running', stopping: true, canStop: true } });
      expect(f.requests()).toBe(1);
      expect(f.sessions[0]!.channel.writes).toEqual(source === 'terminal-close' ? [] : ['\u0003']);
      expect(() => f.runner.terminalInput(id, 'pwd\n')).toThrow('等待命令退出');
      expect(f.events.filter((event) => event.type === 'task-message' && event.interruption)).toHaveLength(1);
      expect(f.events.filter((event) => event.type === 'operation').at(-1)).toMatchObject({ value: { status: 'unknown', interruption: { source } } });
      f.sessions[0]!.channel.complete();
      expect(f.events.filter((event) => event.type === 'execution').at(-1)).toMatchObject({ value: { model: 'idle', remote: 'idle', stopping: false, canStop: false } });
      expect(f.events.filter((event) => event.type === 'operation').at(-1)).toMatchObject({ value: { status: 'succeeded', exitCode: 0, interruption: { source } } });
      f.runner.terminalInput(id, 'pwd\n');
      expect(f.requests()).toBe(1);
      f.runner.message('请核验状态，不要重试');
      await vi.waitFor(() => expect(f.requests()).toBe(2), { timeout: 15000 });
      expect(JSON.stringify(f.fixture.requests[1]!.messages)).toContain('CloudHelm user interruption');
      expect(JSON.stringify(f.fixture.requests[1]!.messages)).toContain(source);
      expect(JSON.stringify(f.fixture.requests[1]!.messages)).toContain('Do not automatically retry');
      expect(f.sessions.flatMap((session) => session.channel.commands)).toEqual(['df -h']);
    } finally { f.runner.pause(); await f.fixture.close(); }
  });

  it('coalesces explicit resume requests and cancels a replacement terminal opened during stop', async () => {
    const f = await setup(false);
    const opening = deferred();
    try {
      const running = f.runner.start();
      await vi.waitFor(() => expect(f.sessions[0]?.channel.commands).toEqual(['df -h']), { timeout: 15000 });
      f.runner.stopOperation(); await running;
      f.sessions[0]!.channel.complete();
      f.control.openBarrier = opening.promise;
      const resuming = f.runner.resume();
      expect(f.runner.resume()).toBe(resuming);
      await vi.waitFor(() => expect(f.sessions).toHaveLength(2), { timeout: 15000 });
      f.runner.pause(); opening.resolve(); await resuming;
      expect(f.events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'paused' });
      expect(f.requests()).toBe(1);
      expect(f.terminal.currentGeneration(f.sessions[1]!.id)).toBe(-1);
      expect(f.events.some((event) => event.type === 'terminal-replaced')).toBe(false);
    } finally { opening.resolve(); f.runner.pause(); await f.fixture.close(); }
  });
});
