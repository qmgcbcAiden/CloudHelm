import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, type InputRequest, type ProposedOperation, type RawTerminal } from '@cloudhelm/core';
import type { SshTransport } from '@cloudhelm/adapters';
import { OperationInputBridge } from './operation-input-bridge.js';

class FakeTerminal implements RawTerminal {
  writes: string[] = [];
  private listener?: (data: string) => void;
  write(data: string): void { this.writes.push(data); }
  resize(): void {}
  close(): void {}
  onData(listener: (data: string) => void): void { this.listener = listener; }
  onClose(): void {}
  emit(data: string): void { this.listener?.(data); }
}
class Pipe extends EventEmitter {
  writes: string[] = [];
  write(data: string): boolean { this.writes.push(data); return true; }
  end(): void {}
  close(): void { this.emit('close'); }
}

function fixture(command = 'sudo apt install docker.io', probe = 'su from util-linux 2.40\nsetsid from util-linux 2.40\nservice:x:1001:1001::/home/service:/bin/bash\n/bin/bash\n/bin/sh') {
  const channel = new FakeTerminal();
  const terminal = new TerminalManager({ data() {}, state() {} });
  const terminalId = terminal.open('host', channel, 'task');
  const requests: InputRequest[] = [];
  const coordinator = new InteractionCoordinator(terminal, { opened: (request) => requests.push(request), closed() {} });
  const pipes: Pipe[] = [];
  let generation = 1;
  const execFixed = vi.fn().mockResolvedValue({ exitCode: 0, output: probe });
  const ssh = { execFixed, openPipe: vi.fn().mockImplementation(async () => { const pipe = new Pipe(); pipes.push(pipe); return pipe; }),
    connectionGeneration: () => generation } as unknown as SshTransport;
  const auto = vi.fn();
  const bridge = new OperationInputBridge(terminal, ssh, coordinator, auto);
  const operation: ProposedOperation = { id: 'op', kind: 'command', command, scope: {
    taskId: 'task', hostId: 'host', cwd: '/', runAs: 'deploy', terminalId,
    terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'Install service'
  } };
  const abort = new AbortController();
  const result = bridge.execute(operation, operationFingerprint(operation), abort.signal);
  const ready = () => vi.waitFor(() => expect(channel.writes).toHaveLength(1));
  const auth = () => {
    const token = /(__CLOUDHELM_AUTH_[a-f\d]+__)/u.exec(execFixed.mock.calls.flat().join(' '))?.[1];
    pipes[0]!.emit('data', `${token}\n`);
  };
  const complete = () => {
    const marker = /(__CLOUDHELM_DONE_[a-f\d]+__)/u.exec(channel.writes[0] ?? '')?.[1];
    channel.emit(`\r\n${marker}:0\r\n`);
  };
  return { channel, terminal, terminalId, coordinator, requests, pipes, auto, execFixed, result, ready, auth, complete, abort,
    disconnect: () => { generation++; } };
}

afterEach(() => vi.useRealTimers());

describe('operation-specific credential isolation', () => {
  it('ignores shared PTY Password text; only a dedicated askpass challenge can request a secret', async () => {
    const f = fixture(); await f.ready();
    f.channel.emit('Password: ');
    expect(f.requests).toHaveLength(0);
    f.auth();
    expect(f.requests).toHaveLength(1);
    expect(await f.coordinator.answer(f.requests[0]!.id, 'one-password')).toBe(true);
    expect(f.pipes[1]!.writes).toEqual(['one-password\n']);
    expect(f.pipes[2]!.writes).toEqual([]);
    expect(f.channel.writes.join('')).not.toContain('one-password');
    expect(f.channel.writes[0]).toContain('sudo -A');
    expect(f.channel.writes[0]).not.toContain('sudo -S');
    expect(await f.coordinator.answer(f.requests[0]!.id, 'repeat')).toBe(false);
    f.complete(); await f.result;
  });

  it('rejects a late secret after authenticated payload starts', async () => {
    const f = fixture(); await f.ready(); f.auth();
    const marker = /(__CLOUDHELM_AUTH_END_[a-f\d]+__)/u.exec(f.channel.writes[0]!)![1];
    f.pipes[0]!.emit('data', `${marker}\n`);
    expect(await f.coordinator.answer(f.requests[0]!.id, 'late')).toBe(false);
    expect(f.pipes[1]!.writes).toEqual([]);
    f.complete(); await f.result;
  });

  it.each(['exit', 'takeover', 'cancel', 'disconnect'] as const)('invalidates a pending secret on %s', async (event) => {
    const f = fixture(); await f.ready(); f.auth();
    if (event === 'exit') { f.complete(); await f.result; }
    if (event === 'takeover') f.terminal.takeOver(f.terminalId);
    if (event === 'cancel') f.abort.abort();
    if (event === 'disconnect') { f.disconnect(); f.terminal.suspend(f.terminalId); }
    expect(await f.coordinator.answer(f.requests[0]!.id, 'late')).toBe(false);
    expect(f.pipes[1]!.writes).toEqual([]);
    await f.result;
  });

  it('rejects line injection and does not retain an answer for a later challenge', async () => {
    const f = fixture(); await f.ready(); f.auth();
    expect(await f.coordinator.answer(f.requests[0]!.id, 'password\nrm -rf /')).toBe(false);
    expect(f.pipes[1]!.writes).toEqual([]);
    await f.result;
  });

  it('expires a waiting challenge without sending a remote kill or an answer', async () => {
    const f = fixture(); await f.ready();
    vi.useFakeTimers(); f.auth();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(await f.coordinator.answer(f.requests[0]!.id, 'late')).toBe(false);
    expect(f.pipes[1]!.writes).toEqual([]);
    expect(f.execFixed.mock.calls.flat().join(' ')).not.toMatch(/\bkill\b/u);
    await f.result;
  });

  it('bounds repeated password attempts', async () => {
    const f = fixture(); await f.ready();
    for (let attempt = 0; attempt < 3; attempt++) {
      f.auth(); expect(await f.coordinator.answer(f.requests[attempt]!.id, 'wrong')).toBe(true);
    }
    f.auth();
    expect(f.requests).toHaveLength(3);
    expect((await f.result).status).toBe('unknown');
  });

  it('supports a bounded util-linux su channel with stdin closed before payload evaluation', async () => {
    const f = fixture("su service -c 'echo ready'"); await f.ready();
    expect(f.channel.writes[0]).toContain('/usr/bin/setsid --wait');
    expect(f.channel.writes[0]).toContain('/usr/bin/su --shell /bin/sh');
    expect(f.channel.writes[0]!.indexOf('exec 0</dev/null')).toBeLessThan(f.channel.writes[0]!.indexOf('echo ready'));
    f.channel.emit('Password:'); expect(f.requests).toHaveLength(0);
    f.pipes[0]!.emit('data', 'Pass'); f.pipes[0]!.emit('data', 'word: ');
    expect(f.requests[0]?.recipient).toBe('su (service)');
    expect(await f.coordinator.answer(f.requests[0]!.id, 'target-password')).toBe(true);
    expect(f.pipes[1]!.writes).toEqual(['target-password\n']);
    f.complete(); await f.result;
  });

  it('stops unsupported su implementations before requesting any secret', async () => {
    const f = fixture("su service -c 'echo ready'", 'BusyBox su');
    expect((await f.result).status).toBe('failed');
    expect(f.channel.writes).toEqual([]); expect(f.requests).toEqual([]);
  });

  it('rejects restricted or arbitrary target login programs before asking for credentials', async () => {
    const f = fixture("su service -c 'echo ready'", 'su from util-linux 2.40\nsetsid from util-linux 2.40\nservice:x:1001:1001::/home/service:/usr/bin/python3\n/bin/sh');
    expect((await f.result).status).toBe('failed'); expect(f.requests).toEqual([]); expect(f.channel.writes).toEqual([]);
  });

  it('suspends unfamiliar PAM challenges instead of relabeling them as a password', async () => {
    const f = fixture("su service -c 'echo ready'"); await f.ready();
    f.pipes[0]!.emit('data', 'Your password has expired. New password: ');
    expect((await f.result).status).toBe('unknown'); expect(f.requests).toEqual([]);
  });
});

describe('bounded apt confirmation', () => {
  it('reuses approval only for an install summary with zero removals', async () => {
    const f = fixture('apt install docker.io'); await f.ready();
    const output = '0 upgraded, 3 newly installed, 0 to remove and 0 not upgraded.\r\nDo you want to continue? [Y/n] ';
    f.channel.emit(output); f.channel.emit(output);
    expect(f.pipes[2]!.writes).toEqual(['y\n']); expect(f.pipes[1]!.writes).toEqual([]);
    expect(f.auto).toHaveBeenCalledOnce(); expect(f.requests).toEqual([]);
    f.complete(); await f.result;
  });

  it.each([
    '0 to remove\n',
    '0 upgraded, 3 newly installed, 2 to remove and 0 not upgraded.\n',
    '0 upgraded, 3 newly installed, 0 to remove and 0 not upgraded.\n0 upgraded, 3 newly installed, 1 to remove and 0 not upgraded.\n',
    '0 upgraded, 3 newly installed, 0 to remove and 0 not upgraded.\nOverwrite configuration file?\n'
  ])('suspends changed or ambiguous impacts without a generic yes dialog', async (summary) => {
    const f = fixture('apt install docker.io'); await f.ready();
    f.channel.emit(`${summary}Do you want to continue? [Y/n] `);
    expect((await f.result).status).toBe('unknown');
    expect(f.pipes[2]!.writes).toEqual(['n\n']); expect(f.requests).toEqual([]);
  });
});
