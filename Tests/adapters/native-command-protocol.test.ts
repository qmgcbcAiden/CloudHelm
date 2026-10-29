import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { CommandNotStartedError, type RawTerminalExecutionContext } from '@cloudhelm/core';
import { SshCommandTerminal } from '../../packages/adapters/src/ssh-command-terminal.js';
import type { SshTransport } from '../../packages/adapters/src/ssh-transport.js';

const binding = { version: 1, operationId: 'operation', sessionId: 'session', generation: 1 };
const started = { type: 'started', pid: 42, supervisorUid: 1000, supervisorEuid: 1000 };
const auth = (id = 'a'.repeat(32)) => ({ type: 'auth', id, prompt: 'Password:', promptSha256: 'b'.repeat(64) });
class Channel extends EventEmitter {
  stderr = new EventEmitter();
  writes: string[] = [];
  ended = false;
  afterSetup?: () => void;
  override on(name: string, listener: (...args: any[]) => void): this {
    super.on(name, listener); if (name === 'close') this.afterSetup?.(); return this;
  }
  write(data: string): void { this.writes.push(data); }
  end(): void { this.ended = true; }
  close(): void { this.emit('close'); }
  event(value: Record<string, unknown>): void { this.emit('data', Buffer.from(JSON.stringify({ ...binding, ...value }) + '\n')); }
}
function fixture(sudo = true) {
  const channel = new Channel();
  const openPipe = vi.fn(async () => channel);
  const ssh = { connectionGeneration: () => 1, prepareCommandProgram: async () => '/tmp/runtime/helper', openPipe } as unknown as SshTransport;
  const terminal = new SshCommandTerminal(ssh, 'host');
  const exit = vi.fn(), output = vi.fn(), authentication = vi.fn();
  terminal.agent.onExit!(exit); terminal.onData(output); terminal.agent.onAuthentication!(authentication);
  const context: RawTerminalExecutionContext = { ...binding, plan: { version: 1, shell: 'bash', steps: [{ condition: 'always',
    argv: sudo ? ['sudo', '-A', 'id'] : ['/bin/bash', '--noprofile', '--norc', '-c', 'id'], runAs: sudo ? 'root' : 'user', authentication: sudo ? 'sudo' : 'none' }] } };
  const execute = (authorized = () => true) => terminal.agent.execute('id', '/', authorized, context);
  return { channel, openPipe, terminal, exit, output, authentication, execute, context };
}

it('classifies SSH-open failure before the first launch as not started', async () => {
  const f = fixture(); f.openPipe.mockRejectedValueOnce(new Error('SSH unavailable'));
  await expect(f.execute()).rejects.toBeInstanceOf(CommandNotStartedError);
  expect(f.channel.writes).toEqual([]); expect(f.exit).not.toHaveBeenCalled();
});

it.each(['after-open', 'after-listeners'] as const)('never sends a launch after authorization expires %s', async (phase) => {
  const f = fixture(); let authorized = true;
  if (phase === 'after-open') f.openPipe.mockImplementationOnce(async () => { authorized = false; return f.channel; });
  else f.channel.afterSetup = () => { authorized = false; };
  await expect(f.execute(() => authorized)).rejects.toBeInstanceOf(CommandNotStartedError);
  expect(f.channel.writes).toEqual([]); expect(f.exit).not.toHaveBeenCalled(); expect(f.channel.ended).toBe(true);
});

it('keeps the whole operation unknown when a later step fails before dispatch', async () => {
  const f = fixture(false); f.context.plan!.steps.push({ ...f.context.plan!.steps[0]! });
  f.openPipe.mockResolvedValueOnce(f.channel).mockRejectedValueOnce(new Error('SSH unavailable'));
  await f.execute(); f.channel.event(started); f.channel.event({ type: 'exit', code: 0 });
  await vi.waitFor(() => expect(f.exit).toHaveBeenCalledExactlyOnceWith(undefined));
});

it.each([
  ['data before started', [{ type: 'data', dataBase64: Buffer.from('forbidden').toString('base64') }]],
  ['exit before started', [{ type: 'exit', code: 0 }]],
  ['auth before started', [auth()]],
  ['duplicate started', [started, started]],
  ['launch-error after started', [started, { type: 'launch-error', kind: 'unsupported', code: 'sudo-unavailable' }]],
  ['duplicate auth ID', [started, auth(), { type: 'auth-close', id: 'a'.repeat(32) }, auth()]],
  ['overlapping auth', [started, auth(), auth('c'.repeat(32))]],
  ['unknown auth-close', [started, { type: 'auth-close', id: 'c'.repeat(32) }]],
  ['duplicate prompt', [started, { type: 'prompt', data: '$ ' }, { type: 'prompt', data: '# ' }]],
  ['noncanonical base64', [started, { type: 'data', dataBase64: 'Zh==' }]],
  ['invalid exit code', [started, { type: 'exit', code: -1 }]]
] as const)('fails closed on %s', async (_name, events) => {
  const f = fixture(); await f.execute();
  for (const event of events) f.channel.event(event);
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(f.output.mock.calls.flat().join('')).not.toContain('forbidden');
});

it('bounds the incoming frame before accepting its data', async () => {
  const f = fixture(); await f.execute(); f.channel.event(started);
  f.channel.event({ type: 'data', dataBase64: 'A'.repeat(2 * 1024 * 1024) });
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(undefined); expect(f.output).not.toHaveBeenCalled();
});

it('bounds the number of distinct authentication challenges', async () => {
  const f = fixture(); await f.execute(); f.channel.event(started);
  for (const character of ['a', 'b', 'c']) {
    const id = character.repeat(32); f.channel.event(auth(id)); f.channel.event({ type: 'auth-close', id });
  }
  f.channel.event(auth('d'.repeat(32)));
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('accepts two sequential PAM challenges but never reuses the prior ID', async () => {
  const f = fixture(); await f.execute(); f.channel.event(started); f.channel.event(auth());
  expect(f.terminal.agent.answerAuthentication!('a'.repeat(32), 'fixture-password')).toBe(true);
  f.channel.event({ type: 'auth-close', id: 'a'.repeat(32) }); f.channel.event(auth('c'.repeat(32)));
  expect(f.terminal.agent.answerAuthentication!('a'.repeat(32), 'late')).toBe(false);
  expect(f.terminal.agent.answerAuthentication!('c'.repeat(32), 'fixture-otp')).toBe(true);
  f.channel.event({ type: 'auth-close', id: 'c'.repeat(32) }); f.channel.event({ type: 'exit', code: 0 });
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
});
