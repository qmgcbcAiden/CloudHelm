import { afterEach, describe, expect, it, vi } from 'vitest';
import { InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, type AuthenticationChallenge, type InputRequest, type ProposedOperation, type RawTerminal } from '@cloudhelm/core';
import type { SshTransport } from '@cloudhelm/adapters';
import { OperationInputBridge } from '../../../apps/desktop/src/worker/operation-input-bridge.js';

class FakeTerminal implements RawTerminal {
  readonly agent: import('@cloudhelm/core').AgentExecutionPort = this;
  writes: string[] = [];
  commands: string[] = [];
  answers: Array<{ id: string; answer: string | null }> = [];
  private listener?: (data: string) => void;
  private exited?: (code: number | undefined) => void;
  private authentication?: (challenge: AuthenticationChallenge) => void;
  private waiting?: string;
  async execute(command: string): Promise<void> { this.commands.push(command); }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  onAuthentication(listener: (challenge: AuthenticationChallenge) => void): void { this.authentication = listener; }
  answerAuthentication(id: string, answer: string | null): boolean {
    if (this.waiting !== id || (answer !== null && /[\r\n\u0000]/u.test(answer))) return false;
    this.answers.push({ id, answer }); this.waiting = undefined; return true;
  }
  challenge(id: string, details: Partial<AuthenticationChallenge> = {}): void {
    this.waiting = id; this.authentication?.({ id, prompt: 'sudo', mechanism: 'sudo', processId: 'sudo-process', ...details });
  }
  complete(code = 0): void { this.waiting = undefined; this.exited?.(code); }
  confirmInput(_operationId: string, data: 'y\n' | 'n\n'): boolean { this.writes.push(data); return true; }
  interrupt(): boolean { this.writes.push('\u0003'); return true; }
  resize(): void {}
  close(): void {}
  onData(listener: (data: string) => void): void { this.listener = listener; }
  onClose(): void {}
  emit(data: string): void { this.listener?.(data); }
}

function fixture(command = 'sudo apt install docker.io', cacheEnabled = false) {
  const channel = new FakeTerminal();
  const terminal = new TerminalManager({ data() {}, state() {} });
  const terminalId = terminal.open('host', channel, 'task');
  const requests: InputRequest[] = [];
  const coordinator = new InteractionCoordinator(terminal, { opened: (request) => requests.push(request), closed() {} });
  let generation = 1;
  const ssh = { connectionGeneration: () => generation } as unknown as SshTransport;
  const auto = vi.fn();
  const bridge = new OperationInputBridge(terminal, ssh, coordinator, auto);
  const operation: ProposedOperation = { id: 'op', kind: 'command', command, scope: {
    taskId: 'task', hostId: 'host', cwd: '/', loginAs: 'deploy', runAs: 'deploy', terminalId,
    sudoCachePolicy: { mode: cacheEnabled ? 'single-password-auto' : 'disabled', revision: 1 },
    terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'Install service'
  } };
  const abort = new AbortController();
  const result = bridge.execute(operation, operationFingerprint(operation), abort.signal);
  const ready = () => vi.waitFor(() => expect(channel.commands).toEqual([command]), { timeout: 15000 });
  const auth = () => channel.challenge(`challenge-${requests.length}`);
  return { channel, terminal, terminalId, coordinator, requests, auto, result, ready, auth, abort, bridge,
    again: (id: string, nextCommand = command) => {
      const next = { ...operation, id, command: nextCommand };
      return bridge.execute(next, operationFingerprint(next), abort.signal);
    },
    disconnect: () => { generation++; } };
}

afterEach(() => vi.useRealTimers());

describe('ordinary sudo commands with isolated authentication', () => {
  it('requests credentials only when each sudo in a compound command actually asks', async () => {
    const f = fixture("sudo ls /root; echo '--- content ---'; sudo cat /root/test"); await f.ready();
    expect(f.requests).toEqual([]);
    f.auth(); await f.coordinator.answer(f.requests[0]!.id, 'first-password');
    f.channel.emit('--- content ---\r\n');
    f.auth(); await f.coordinator.answer(f.requests[1]!.id, 'second-password');
    f.channel.complete();
    expect((await f.result).status).toBe('succeeded');
    expect(f.channel.writes).toEqual([]);
    expect(f.channel.answers).toHaveLength(2);
  });
  it('executes the exact reviewed command; only a transport challenge can request a password', async () => {
    const f = fixture('sudo od -c /root/test/test'); await f.ready();
    f.channel.emit('Password: '); expect(f.requests).toHaveLength(0);
    f.auth(); expect(f.requests).toHaveLength(1);
    expect(await f.coordinator.answer(f.requests[0]!.id, 'one-password')).toBe(true);
    expect(f.channel.answers).toEqual([{ id: 'challenge-0', answer: 'one-password' }]);
    expect(f.channel.commands).toEqual(['sudo od -c /root/test/test']);
    expect(f.channel.writes).toEqual([]);
    expect(await f.coordinator.answer(f.requests[0]!.id, 'repeat')).toBe(false);
    f.channel.complete(); await f.result;
  });

  it.each(['sudo ls /root | cat', "su root -c 'cat /root/test'", 'sudo -S cat /root/test'])(
    'stops an unsupported form without converting it into a script: %s', async (command) => {
      const f = fixture(command);
      expect(await f.result).toMatchObject({ status: 'failed', requiresUserAction: true });
      expect(f.channel.commands).toEqual([]); expect(f.requests).toEqual([]);
    }
  );

  it('pauses when sudo rejects authentication', async () => {
    const f = fixture('sudo ls /root'); await f.ready(); f.auth();
    await f.coordinator.answer(f.requests[0]!.id, 'wrong');
    f.channel.emit('sudo: 1 incorrect password attempt\r\n'); f.channel.complete(1);
    expect(await f.result).toMatchObject({ status: 'failed', requiresUserAction: true });
    expect(f.terminal.isAgentOwner(f.terminalId)).toBe(false);
  });

  it('keeps a payload failure distinct from sudo authentication failure', async () => {
    const f = fixture('sudo ls /root/missing'); await f.ready();
    f.channel.emit('ls: no such file\r\n'); f.channel.complete(2);
    expect((await f.result).requiresUserAction).not.toBe(true);
    expect(f.terminal.isAgentOwner(f.terminalId)).toBe(true);
  });

  it.each(['exit', 'takeover', 'cancel', 'disconnect'] as const)('invalidates a waiting password on %s', async (event) => {
    const f = fixture(); await f.ready(); f.auth();
    if (event === 'exit') { f.channel.complete(); await f.result; }
    if (event === 'takeover') f.terminal.takeOver(f.terminalId);
    if (event === 'cancel') f.abort.abort();
    if (event === 'disconnect') { f.disconnect(); f.terminal.suspend(f.terminalId); }
    expect(await f.coordinator.answer(f.requests[0]!.id, 'late-secret')).toBe(false);
    expect(f.channel.answers.some((answer) => answer.answer === 'late-secret')).toBe(false);
    expect(f.channel.writes).toEqual([]);
    await f.result;
  });

  it('expires a password popup and rejects newline injection', async () => {
    const f = fixture(); await f.ready(); f.auth();
    expect(await f.coordinator.answer(f.requests[0]!.id, 'secret\necho injected')).toBe(false);
    expect((await f.result).status).toBe('unknown');
    expect(f.channel.writes).toEqual([]);
  });

  it('times out without sending credentials or killing the remote process', async () => {
    const f = fixture(); await f.ready(); vi.useFakeTimers(); f.auth();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(await f.coordinator.answer(f.requests[0]!.id, 'late')).toBe(false);
    expect((await f.result).status).toBe('unknown'); expect(f.channel.writes).toEqual([]);
  });

  it('bounds repeated authentication attempts', async () => {
    const f = fixture(); await f.ready();
    for (let i = 0; i < 3; i++) { f.auth(); await f.coordinator.answer(f.requests[i]!.id, 'wrong'); }
    f.auth(); expect(f.requests).toHaveLength(3);
    expect((await f.result).status).toBe('unknown');
  });
});

describe('bounded ordinary apt confirmation', () => {
  it('answers through normal process input after a zero-removal summary', async () => {
    const f = fixture(); await f.ready();
    const output = '0 upgraded, 3 newly installed, 0 to remove and 0 not upgraded.\r\nDo you want to continue? [Y/n] ';
    f.channel.emit(output); f.channel.emit(output);
    expect(f.channel.writes).toEqual(['y\n']); expect(f.channel.answers).toEqual([]);
    expect(f.auto).toHaveBeenCalledOnce(); f.channel.complete(); await f.result;
  });

  it.each(['0 to remove\n', '0 upgraded, 3 newly installed, 2 to remove and 0 not upgraded.\n'])(
    'refuses ambiguous or changed impacts', async (summary) => {
      const f = fixture('apt install docker.io'); await f.ready();
      f.channel.emit(`${summary}Do you want to continue? [Y/n] `);
      expect((await f.result).status).toBe('unknown'); expect(f.channel.writes).toEqual(['n\n']);
    }
  );
});


it('reuses only successfully verified credentials, with no ordinary stdin or second popup', async () => {
  const f = fixture('sudo docker ps', true); await f.ready(); f.auth();
  expect(f.requests[0]!.allowPasswordCache).toBe(true);
  await f.coordinator.answer(f.requests[0]!.id, { action: 'submit', value: 'verified-fixture', cacheAsPassword: true }); f.channel.complete();
  expect(await f.result).toMatchObject({ authentication: 'succeeded' });
  const next = f.again('second'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(2), { timeout: 15_000 });
  f.channel.challenge('second-auth'); expect(f.requests).toHaveLength(1);
  expect(f.channel.answers.at(-1)).toEqual({ id: 'second-auth', answer: 'verified-fixture' });
  f.channel.complete(); await next; expect(f.channel.writes).toEqual([]); f.bridge.clearTask('task');
});

it('forgets a reused password when challenged again, and prompts instead of looping', async () => {
  const f = fixture('sudo docker ps', true); await f.ready(); f.auth();
  await f.coordinator.answer(f.requests[0]!.id, { action: 'submit', value: 'old', cacheAsPassword: true }); f.channel.complete(); await f.result;
  const next = f.again('second'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(2), { timeout: 15_000 });
  f.channel.challenge('cached'); f.channel.challenge('retry'); expect(f.requests).toHaveLength(2);
  await f.coordinator.answer(f.requests[1]!.id, 'new'); f.channel.emit('Sorry, try again.\n'); f.channel.complete();
  expect(await next).toMatchObject({ status: 'succeeded', authentication: 'succeeded' }); f.bridge.clearTask('task');
});

it('does not cache a password after a failed operation, or retain it after a task pause', async () => {
  const f = fixture('sudo docker ps', true); await f.ready(); f.auth();
  await f.coordinator.answer(f.requests[0]!.id, { action: 'submit', value: 'unverified', cacheAsPassword: true }); f.channel.emit('payload failed\n'); f.channel.complete(1); await f.result;
  const next = f.again('second'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(2), { timeout: 15_000 });
  f.channel.challenge('second'); expect(f.requests).toHaveLength(2);
  await f.coordinator.answer(f.requests[1]!.id, { action: 'submit', value: 'verified', cacheAsPassword: true }); f.channel.complete(); await next;
  f.bridge.clearTask('task');
  const third = f.again('third'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(3), { timeout: 15_000 });
  f.channel.challenge('third'); expect(f.requests).toHaveLength(3); f.channel.complete(); await third;
});

it('does not suspend a live task for an unsupported sudo status probe', async () => {
  const f = fixture('sudo -n -l');
  expect(await f.result).toMatchObject({ status: 'failed', failureKind: 'unsupported', effects: 'none' });
  expect(f.terminal.isAgentOwner(f.terminalId)).toBe(true); expect(f.channel.commands).toEqual([]);
});

it('refuses the sudo -n true capability probe without dispatching it', async () => {
  const f = fixture('sudo -n true');
  expect(await f.result).toMatchObject({ status: 'failed', failureKind: 'unsupported', effects: 'none' });
  expect(f.channel.commands).toEqual([]);
});

it('distinguishes sudo -n requiring a password without laundering possible effects or guessing password rejection', async () => {
  const f = fixture('sudo -n docker ps'); await f.ready(); f.channel.emit('sudo: a password is required\n'); f.channel.complete(1);
  expect(await f.result).toMatchObject({ authentication: 'required', effects: 'possible', requiresUserAction: false,
    privilege: { code: 'authentication-required', source: 'output-inference', businessCommand: 'unknown' } });
  expect(f.terminal.isAgentOwner(f.terminalId)).toBe(true);
});

describe('explicit single-password cache policy', () => {
  it.each([false, true])('does not opt legacy string input into caching (host enabled=%s)', async (enabled) => {
    const f = fixture('sudo docker ps', enabled); await f.ready(); f.auth();
    expect(f.requests[0]!.allowPasswordCache).toBe(enabled);
    await f.coordinator.answer(f.requests[0]!.id, 'private-fixture'); f.channel.complete(); await f.result;
    const next = f.again('second'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(2));
    f.channel.challenge('second'); expect(f.requests).toHaveLength(2);
    expect(f.channel.answers).toEqual([{ id: 'challenge-0', answer: 'private-fixture' }]);
    f.channel.complete(); await next;
  });

  it('does not cache an explicitly unchecked structured answer', async () => {
    const f = fixture('sudo docker ps', true); await f.ready(); f.auth();
    await f.coordinator.answer(f.requests[0]!.id, { action: 'submit', value: 'private-fixture', cacheAsPassword: false });
    f.channel.complete(); await f.result;
    const next = f.again('second'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(2));
    f.channel.challenge('second'); expect(f.requests).toHaveLength(2);
    f.channel.complete(); await next;
  });

  it('never caches either response when a password is followed by an OTP', async () => {
    const f = fixture('sudo docker ps', true); await f.ready(); f.auth();
    await f.coordinator.answer(f.requests[0]!.id, { action: 'submit', value: 'password-fixture', cacheAsPassword: true });
    f.channel.challenge('otp', { kind: 'otp', prompt: 'Verification code:' });
    expect(f.requests[1]).toMatchObject({ kind: 'otp', allowPasswordCache: false });
    expect(await f.coordinator.answer(f.requests[1]!.id, { action: 'submit', value: '123456', cacheAsPassword: true })).toBe(false);
    await f.coordinator.answer(f.requests[1]!.id, { action: 'submit', value: '123456' });
    f.channel.complete(); await f.result;
    const next = f.again('second'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(2));
    f.channel.challenge('second'); expect(f.requests).toHaveLength(3);
    expect(f.channel.answers.at(-1)).toEqual({ id: 'otp', answer: '123456' });
    f.channel.complete(); await next; expect(f.channel.writes).toEqual([]);
  });

  it('does not offer cache opt-in for an explicit OTP as the first challenge', async () => {
    const f = fixture('sudo docker ps', true); await f.ready();
    f.channel.challenge('otp', { kind: 'otp', prompt: 'One-time token:' });
    expect(f.requests[0]).toMatchObject({ kind: 'otp', allowPasswordCache: false });
    await f.coordinator.answer(f.requests[0]!.id, '123456'); f.channel.complete(); await f.result;
  });

  it('pins the complete sanitized prompt, and permanently clears it on a change', async () => {
    const f = fixture('sudo docker ps', true); await f.ready();
    const prefix = 'a'.repeat(300);
    f.channel.challenge('first', { prompt: `\u001b[31m${prefix}Password:\u001b[0m` });
    expect(f.requests[0]!.reason).not.toContain('\u001b');
    await f.coordinator.answer(f.requests[0]!.id, { action: 'submit', value: 'password-fixture', cacheAsPassword: true });
    f.channel.complete(); await f.result;
    const next = f.again('second'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(2));
    f.channel.challenge('changed', { prompt: `${prefix}Token:` }); expect(f.requests).toHaveLength(2);
    await f.coordinator.answer(f.requests[1]!.id, 'token-fixture'); f.channel.complete(); await next;
    const third = f.again('third'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(3));
    f.channel.challenge('original', { prompt: `${prefix}Password:` }); expect(f.requests).toHaveLength(3);
    f.channel.complete(); await third;
  });

  it('distinguishes raw prompt hashes even when display sanitization yields identical text', async () => {
    const f = fixture('sudo docker ps', true); await f.ready();
    f.channel.challenge('first', { prompt: '\u001b[31mPassword:\u001b[0m', promptSha256: 'a'.repeat(64) });
    await f.coordinator.answer(f.requests[0]!.id, { action: 'submit', value: 'password-fixture', cacheAsPassword: true });
    f.channel.complete(); await f.result;
    const next = f.again('second'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(2));
    f.channel.challenge('changed', { prompt: 'Password:', promptSha256: 'b'.repeat(64) });
    expect(f.requests).toHaveLength(2);
    expect(f.channel.answers).toEqual([{ id: 'first', answer: 'password-fixture' }]);
    f.channel.complete(); await next;
  });

  it('clears an existing pin when a later challenge has an empty display prompt', async () => {
    const f = fixture('sudo docker ps', true); await f.ready(); f.auth();
    await f.coordinator.answer(f.requests[0]!.id, { action: 'submit', value: 'password-fixture', cacheAsPassword: true });
    f.channel.complete(); await f.result;
    const next = f.again('second'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(2));
    f.channel.challenge('empty', { prompt: '' });
    expect(f.requests[1]!.allowPasswordCache).toBe(false);
    await f.coordinator.answer(f.requests[1]!.id, 'manual-fixture'); f.channel.complete(); await next;
    const third = f.again('third'); await vi.waitFor(() => expect(f.channel.commands).toHaveLength(3));
    f.channel.challenge('original'); expect(f.requests).toHaveLength(3);
    f.channel.complete(); await third;
  });

  it.each(['host-policy', 'payload-failure', 'ordinary-failure'] as const)('clears an existing cached credential on %s', async (event) => {
    const f = fixture('sudo docker ps', true); await f.ready(); f.auth();
    await f.coordinator.answer(f.requests[0]!.id, { action: 'submit', value: 'password-fixture', cacheAsPassword: true });
    f.channel.complete(); await f.result;
    if (event === 'host-policy') f.bridge.clearHost('host');
    else {
      const failed = f.again('failed', event === 'ordinary-failure' ? 'false' : 'sudo docker ps');
      await vi.waitFor(() => expect(f.channel.commands).toHaveLength(2));
      if (event !== 'ordinary-failure') f.channel.challenge('reuse');
      expect(f.requests).toHaveLength(1);
      f.channel.emit('payload failed\n'); f.channel.complete(1); await failed;
    }
    const next = f.again('after-clear');
    await vi.waitFor(() => expect(f.channel.commands).toHaveLength(event === 'host-policy' ? 2 : 3));
    f.channel.challenge('after-clear'); expect(f.requests).toHaveLength(2);
    f.channel.complete(); await next;
  });

  it('counts three requests per sudo process while prohibiting compound-command caching', async () => {
    const f = fixture('sudo id; sudo whoami', true); await f.ready();
    for (let i = 0; i < 6; i++) {
      const processId = i < 3 ? 'first-sudo' : 'second-sudo';
      f.channel.challenge(`request-${i}`, { processId });
      expect(f.requests[i]).toMatchObject({ allowPasswordCache: false });
      expect(f.requests[i]!.prompt).toContain(`第 ${i % 3 + 1}/3 次请求`);
      await f.coordinator.answer(f.requests[i]!.id, `answer-${i}`);
    }
    f.channel.challenge('fourth-for-second', { processId: 'second-sudo' });
    expect(f.requests).toHaveLength(6);
    expect(await f.result).toMatchObject({ status: 'unknown', privilege: { code: 'attempts-exhausted' } });
  });
});
