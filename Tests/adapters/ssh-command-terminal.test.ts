import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SshTransport } from '../../packages/adapters/src/ssh-transport.js';
import { SshCommandTerminal } from '../../packages/adapters/src/ssh-command-terminal.js';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { buildCommandExecutionPlan } from '@cloudhelm/core';

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  started = false;
  writes: string[] = [];
  write(text: string): void { this.writes.push(text); }
  end(): void {}
  close(): void { this.emit('close'); }
  setWindow = vi.fn();
  event(value: Record<string, unknown>): void {
    const launch = JSON.parse(this.writes[0] ?? '{}'); const { version, operationId, sessionId, generation } = launch;
    if (!this.started && value.type !== 'launch-error') {
      this.started = true;
      this.emit('data', Buffer.from(JSON.stringify({ version, operationId, sessionId, generation, type: 'started',
        pid: 123, supervisorUid: 1000, supervisorEuid: 1000 }) + '\n'));
    }
    const event = value.type === 'data' ? { type: 'data', dataBase64: Buffer.from(String(value.data)).toString('base64') }
      : value.type === 'auth' ? { promptSha256: createHash('sha256').update(String(value.prompt ?? 'sudo 身份验证')).digest('hex'), ...value } : value;
    this.emit('data', Buffer.from(JSON.stringify({ version, operationId, sessionId, generation, ...event }) + '\n'));
  }
}
function fixture() {
  const channel = new Channel();
  const prepareCommandProgram = vi.fn(async () => '/tmp/cloudhelm-run.fixture/helper');
  const channels = [channel];
  const openPipe = vi.fn(async () => {
    if (channels.length === 1 && !channel.writes.length) return channel;
    const next = new Channel(); channels.push(next); return next;
  });
  const human = new Channel();
  const shell = vi.fn(async () => human);
  const ssh = { connectionGeneration: () => 1, prepareCommandProgram, openPipe, shell } as unknown as SshTransport;
  const terminal = new SshCommandTerminal(ssh, 'host');
  const execute = terminal.execute.bind(terminal); const analyzer = new BashAnalyzer();
  terminal.execute = async (command, cwd, current) => execute(command, cwd, current, { operationId: 'operation', sessionId: 'session', generation: 1, plan: buildCommandExecutionPlan(await analyzer.analyze(command), 'test') });
  const output = vi.fn(); const exited = vi.fn(); const auth = vi.fn(); const display = vi.fn();
  terminal.onDisplay(display); terminal.onData(output); terminal.onExit(exited); terminal.onAuthentication(auth);
  return { channel, channels, human, shell, display, terminal, output, exited, auth, prepareCommandProgram, openPipe };
}

describe('direct SSH command transport', () => {
  it.each([
    ["sudo ls -la /root/test; echo '--- content ---'; sudo cat /root/test/test", [0, 0, 0], ['sudo', '/bin/bash', 'sudo']],
    ['sudo false && sudo echo skip || sudo echo recover', [1, 0], ['sudo', 'sudo']],
    ['sudo true || sudo echo skip; sudo echo next', [0, 0], ['sudo', 'sudo']],
    ['sudo true\nsudo echo next', [0, 0], ['sudo', 'sudo']]
  ] as const)('executes foreground list %s with shell conditions', async (command, codes, names) => {
    const f = fixture(); await f.terminal.execute(command, '/', () => true);
    for (const [index, code] of codes.entries()) {
      await vi.waitFor(() => expect(f.channels[index]?.writes.length).toBe(1), { timeout: 15000 });
      const launch = JSON.parse(f.channels[index]!.writes[0]!).payload;
      expect(launch.argv[0]).toBe(names[index]);
      expect(launch.sudo).toBe(names[index] === 'sudo');
      expect(launch.command).toBe(index === 0 ? command : undefined);
      expect(launch.argv).not.toContain('skip');
      f.channels[index]!.event({ type: 'exit', code });
    }
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(['sudo cat /root/test &', 'sudo cat /root/test | cat', 'sudo -S cat /root/test',
    'sudo sh -c "cat /root/test"', 'if true; then sudo id; fi', 'sudo echo "$HOME"',
    '(sudo id)', 'sudo id > /tmp/output'])('does not misparse %s into a foreground list', async (command) => {
    const f = fixture();
    await expect(f.terminal.execute(command, '/', () => true)).rejects.toThrow('authentication');
    expect(f.openPipe).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'disconnect'] as const)('never sends the next command after %s', async (reason) => {
    const f = fixture(); let authorized = true;
    await f.terminal.execute('sudo id; sudo mkdir /root/test', '/', () => authorized);
    if (reason === 'revoked') { authorized = false; f.channel.event({ type: 'exit', code: 0 }); }
    else f.channel.emit('close');
    await vi.waitFor(() => expect(f.exited).toHaveBeenCalledWith(undefined), { timeout: 15000 });
    expect(f.openPipe).toHaveBeenCalledOnce();
  });

  it('keeps full prompts and command echo out of captured output', async () => {
    const f = fixture(); f.terminal.agent.resize!(132, 42);
    await f.terminal.execute('sudo id', '/home/ubuntu', () => true);
    expect(JSON.parse(f.channel.writes[0]!).payload).toMatchObject({ cols: 132, rows: 42 });
    const prompt = '\u001b[01;32mubuntu@instance\u001b[00m:~$ ';
    f.channel.event({ type: 'prompt', data: prompt });
    f.channel.event({ type: 'display', data: `${prompt}sudo id\r\n` });
    f.channel.event({ type: 'data', data: 'uid=0(root)\r\n' });
    f.channel.event({ type: 'exit', code: 0 });
    expect(f.display.mock.calls.flat().join('')).toBe(`${prompt}sudo id\r\n${prompt}`);
    expect(f.output).toHaveBeenCalledExactlyOnceWith('uid=0(root)\r\n');
  });

  it('opens a sized interactive shell on the first explicit input after idle takeover', async () => {
    const f = fixture(); f.terminal.agent.resize!(132, 42); f.terminal.takeOver();
    expect(f.shell).not.toHaveBeenCalled();
    f.terminal.human.write('su -\r');
    await vi.waitFor(() => expect(f.human.writes).toEqual(['su -\r']), { timeout: 15000 });
    expect(f.shell).toHaveBeenCalledExactlyOnceWith('host', 132, 42);
    expect(f.human.setWindow).toHaveBeenCalledWith(42, 132, 0, 0);
  });

  it('states the handover and erases the synthetic prompt before a later takeover shell', async () => {
    const f = fixture(); await f.terminal.execute('du -xhd1 /usr', '/home/tian', () => true);
    f.channel.event({ type: 'prompt', data: 'tian@ubuntu:~$ ' });
    f.channel.event({ type: 'data', data: '3.4G\t/usr\n' });
    f.channel.event({ type: 'exit', code: 0 });
    expect(f.output).toHaveBeenCalledExactlyOnceWith('3.4G\t/usr\n');
    expect(f.display.mock.calls.flat().join('')).toBe('tian@ubuntu:~$ ');
    f.terminal.takeOver();
    expect(f.shell).not.toHaveBeenCalled(); f.terminal.human.write('pwd\n');
    await vi.waitFor(() => expect(f.display.mock.calls.flat().join(''))
      .toBe('tian@ubuntu:~$ \r\x1b[2K—— 终端已交还人工输入 ——\r\n'), { timeout: 15000 });
    expect(f.shell).toHaveBeenCalledExactlyOnceWith('host', 100, 30);
  });

  it('skips the synthetic prompt when the exit report hands the terminal over at once', async () => {
    const f = fixture();
    f.exited.mockImplementation(() => f.terminal.takeOver());
    await f.terminal.execute('du -xhd1 /usr', '/home/tian', () => true);
    f.channel.event({ type: 'prompt', data: 'tian@ubuntu:~$ ' });
    f.channel.event({ type: 'data', data: '3.4G\t/usr\n' });
    f.channel.event({ type: 'exit', code: 0 });
    expect(f.shell).not.toHaveBeenCalled(); f.terminal.human.write('pwd\n');
    await vi.waitFor(() => expect(f.display.mock.calls.flat().join(''))
      .toBe('—— 终端已交还人工输入 ——\r\n'), { timeout: 15000 });
    expect(f.shell).toHaveBeenCalledOnce();
  });

  it.each(['od -c /root/test/test', 'sudo od -c /root/test/test'])('passes %s as literal executable arguments', async (command) => {
    const f = fixture(); await f.terminal.execute(command, '/home/ubuntu', () => true);
    expect(JSON.parse(f.channel.writes[0]!).payload).toEqual({ argv: command.startsWith('sudo ') ? ['sudo', '-A', ...command.split(' ').slice(1)] : ['/bin/bash', '--noprofile', '--norc', '-c', command], cwd: '/home/ubuntu', sudo: command.startsWith('sudo '), command, cols: 100, rows: 30 });
    expect(f.openPipe).toHaveBeenCalledWith('host', "\'/tmp/cloudhelm-run.fixture/helper\' --serve");
    expect(f.channel.writes.join('')).not.toMatch(/env -i|SUDO_ASKPASS|\/bin\/sh|CLOUDHELM_DONE/u);
    f.channel.event({ type: 'data', data: 'literal __CLOUDHELM_DONE_example__:0\n' });
    expect(f.exited).not.toHaveBeenCalled();
    f.channel.event({ type: 'exit', code: 7 });
    expect(f.exited).toHaveBeenCalledWith(7);
  });

  it('keeps a canceled or duplicate password out of ordinary input', async () => {
    const f = fixture(); await f.terminal.execute('sudo cat /root/test', '/', () => true);
    const id = 'a'.repeat(32);
    f.channel.event({ type: 'auth', id });
    expect(f.auth).toHaveBeenCalledWith({ id, prompt: 'sudo 身份验证', promptSha256: createHash('sha256').update('sudo 身份验证').digest('hex'), mechanism: 'sudo', kind: 'unknown', processId: 'operation:0' });
    expect(f.terminal.answerAuthentication(id, 'synthetic-password')).toBe(true);
    expect(f.terminal.answerAuthentication(id, 'late')).toBe(false);
    expect(JSON.parse(f.channel.writes[1]!)).toMatchObject({ version: 1, operationId: 'operation', sessionId: 'session', generation: 1, type: 'answer', id, answer: 'synthetic-password' });
    expect(f.output).not.toHaveBeenCalled();
    f.channel.event({ type: 'exit', code: 0 });
    expect(f.terminal.answerAuthentication(id, 'later')).toBe(false);
  });

  it('preserves the entire authentication prompt used by cache binding', async () => {
    const f = fixture(); await f.terminal.execute('sudo id', '/', () => true);
    const prompt = `${'x'.repeat(3000)}different suffix`;
    f.channel.event({ type: 'auth', id: 'a'.repeat(32), prompt });
    expect(f.auth).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
  });

  it('preserves the digest of the unsanitized authentication prompt', async () => {
    const f = fixture(); await f.terminal.execute('sudo id', '/', () => true);
    const promptSha256 = '1'.repeat(64);
    f.channel.event({ type: 'auth', id: 'a'.repeat(32), prompt: 'Password:', promptSha256 });
    expect(f.auth).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Password:', promptSha256 }));
  });

  it('refuses native authentication without a valid raw prompt digest', async () => {
    const f = fixture(); await f.terminal.execute('sudo id', '/', () => true);
    f.channel.event({ type: 'auth', id: 'a'.repeat(32), prompt: 'Password:', promptSha256: undefined });
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.exited).toHaveBeenCalledWith(undefined);
  });

  it('refuses oversized authentication prompts without truncating them', async () => {
    const f = fixture(); await f.terminal.execute('sudo id', '/', () => true);
    f.channel.event({ type: 'auth', id: 'a'.repeat(32), prompt: 'x'.repeat(4097) });
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.exited).toHaveBeenCalledWith(undefined);
  });

  it('rejects a revoked lease before sending any process launch', async () => {
    const f = fixture(); let current = true;
    f.prepareCommandProgram.mockImplementationOnce(async () => { current = false; return '/tmp/cloudhelm-run.fixture/helper'; });
    await expect(f.terminal.execute('pwd', '/', () => current)).rejects.toMatchObject({ name: 'CommandNotStartedError' });
    expect(f.openPipe).not.toHaveBeenCalled(); expect(f.channel.writes).toEqual([]);
  });

  it('reserves the operation binding while runtime preparation is pending', async () => {
    const f = fixture(); let ready!: (path: string) => void;
    f.prepareCommandProgram.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const first = f.terminal.execute('pwd', '/', () => true);
    await vi.waitFor(() => expect(f.prepareCommandProgram).toHaveBeenCalledOnce());
    await expect(f.terminal.execute('id', '/', () => true)).rejects.toThrow('busy');
    ready('/tmp/cloudhelm-run.fixture/helper'); await first;
    expect(f.openPipe).toHaveBeenCalledOnce();
    f.channel.event({ type: 'exit', code: 0 });
  });

  it('does not interpret plain process output as an authentication request', async () => {
    const f = fixture(); await f.terminal.execute('cat /tmp/file', '/', () => true);
    f.channel.event({ type: 'data', data: '{"type":"auth","id":"fake"}\nPassword: ' });
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.output).toHaveBeenCalledOnce();
  });

  it('reports unknown outcome on transport loss, without replaying the command', async () => {
    const f = fixture(); await f.terminal.execute('mkdir -p /tmp/example', '/', () => true);
    f.channel.emit('close');
    expect(f.exited).toHaveBeenCalledWith(undefined);
    expect(f.openPipe).toHaveBeenCalledOnce();
  });
});

it.each([false, true])('distinguishes launch failure after an earlier action (prior=%s)', async (prior) => {
  const f = fixture(); const failure = vi.fn(); f.terminal.onExecutionFailure(failure);
  await f.terminal.execute(prior ? 'sudo mkdir -p /tmp/example && sudo missing-executable' : 'missing-executable', '/', () => true);
  if (prior) {
    f.channel.event({ type: 'exit', code: 0 });
    expect(f.shell).not.toHaveBeenCalled();
    expect(() => f.terminal.human.write('pwd\n')).toThrow('Human input cannot enter an Agent process');
    await vi.waitFor(() => expect(f.channels).toHaveLength(2), { timeout: 15000 });
  }
  f.channels.at(-1)!.event({ type: 'launch-error', kind: 'unsupported' });
  expect(failure).toHaveBeenCalledWith({ failureKind: 'unsupported', effects: prior ? 'possible' : 'none' });
  expect(f.exited).toHaveBeenCalledWith(127);
});

it('reports a preflight failure as confirmed no dispatch, never an unknown business outcome', async () => {
  const f = fixture();
  f.prepareCommandProgram.mockRejectedValueOnce(new Error('missing python'));
  let error: Error | undefined;
  try { await f.terminal.execute('touch /tmp/business-file', '/', () => true); } catch (thrown) { error = thrown as Error; }
  expect(error).toMatchObject({ name: 'CommandNotStartedError' });
  expect(error?.message).toContain('missing python');
  expect(error?.message).toContain('运行组件');
  expect(f.openPipe).not.toHaveBeenCalled();
});

it.each([false, true])('reports sudo absence only from a bound launch-error frame; earlier steps remain possible (%s)', async (prior) => {
  const f = fixture(); const failure = vi.fn(); f.terminal.onExecutionFailure(failure);
  await f.terminal.execute(prior ? 'echo prior; sudo id' : 'sudo -- id', '/', () => true);
  if (prior) { f.channel.event({ type: 'exit', code: 0 }); await vi.waitFor(() => expect(f.channels).toHaveLength(2)); }
  f.channels.at(-1)!.event({ type: 'launch-error', kind: 'unsupported', code: 'sudo-unavailable' });
  expect(failure).toHaveBeenCalledWith({ failureKind: 'unsupported', effects: prior ? 'possible' : 'none', privilege: {
    method: 'sudo', stage: 'preparation', code: 'sudo-unavailable', source: 'transport',
    businessCommand: prior ? 'unknown' : 'not-started', recovery: prior ? 'verify' : 'confirm-alternative' } });
});
it('redacts recognizable secrets from the surfaced preflight cause', async () => {
  const f = fixture();
  f.prepareCommandProgram.mockRejectedValueOnce(new Error('upload failed: password=cleartext'));
  let error: Error | undefined;
  try { await f.terminal.execute('touch /tmp/business-file', '/', () => true); } catch (thrown) { error = thrown as Error; }
  expect(error?.message).not.toContain('cleartext');
  expect(error?.message).toContain('命令未发送');
});

it('rejects a foreign operation frame before accepting its apparent exit', async () => { const f = fixture(); await f.terminal.execute('pwd', '/', () => true); f.channel.event({ type: 'exit', code: 0, operationId: 'foreign' }); expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined); });

it('refuses the human input capability while an Agent operation is active', async () => {
  const f = fixture(); await f.terminal.agent.execute('cat', '/', () => true);
  const initial = [...f.channel.writes];
  expect(() => f.terminal.human.write('echo bypass\n')).toThrow('Human input cannot enter an Agent process');
  await expect(f.terminal.human.open()).rejects.toThrow('Human shell capability is not active');
  expect(f.channel.writes).toEqual(initial); expect(f.human.writes).toEqual([]); expect(f.shell).not.toHaveBeenCalled();
  f.channel.event({ type: 'exit', code: 0 });
});

it('limits Agent input controls to the active operation and a bounded confirmation or terminal response', async () => {
  const f = fixture(); await f.terminal.agent.execute('cat', '/', () => true);
  expect(f.terminal.agent.confirmInput!('foreign', 'y\n')).toBe(false);
  expect(f.terminal.agent.interrupt!('foreign')).toBe(false);
  expect(f.terminal.agent.confirmInput!('operation', 'echo bypass\n' as 'y\n')).toBe(false);
  expect(f.terminal.agent.respondToTerminalQuery!('operation', 'echo bypass\n')).toBe(false);
  expect(f.channel.writes).toHaveLength(1);
  expect(f.terminal.agent.confirmInput!('operation', 'y\n')).toBe(true);
  expect(f.terminal.agent.respondToTerminalQuery!('operation', '\u001b[1;1R')).toBe(true);
  expect(f.terminal.agent.interrupt!('operation')).toBe(true);
  expect(f.channel.writes.slice(1).map((line) => JSON.parse(line))).toEqual(['y\n', '\u001b[1;1R', '\u0003'].map((data) => ({
    version: 1, operationId: 'operation', sessionId: 'session', generation: 1, type: 'input', data: Buffer.from(data).toString('base64')
  })));
  expect(f.shell).not.toHaveBeenCalled(); expect(f.human.writes).toEqual([]);
  f.channel.event({ type: 'exit', code: 0 });
  expect(f.terminal.agent.confirmInput!('operation', 'y\n')).toBe(false);
  expect(f.terminal.agent.interrupt!('operation')).toBe(false);
});

it('opens no shell for automatic terminal responses and keeps later human input on a separate shell', async () => {
  const f = fixture(); await f.terminal.agent.execute('pwd', '/', () => true);
  f.channel.event({ type: 'exit', code: 0 }); f.terminal.takeOver();
  const agentWrites = [...f.channel.writes];
  expect(f.terminal.human.respondToTerminalQuery!('\u001b[1;1R')).toBe(false);
  expect(f.shell).not.toHaveBeenCalled();
  f.terminal.human.write('pwd\n');
  await vi.waitFor(() => expect(f.human.writes).toEqual(['pwd\n']));
  expect(f.terminal.human.respondToTerminalQuery!('\u001b[1;1R')).toBe(true);
  expect(f.human.writes).toEqual(['pwd\n', '\u001b[1;1R']);
  expect(f.channel.writes).toEqual(agentWrites);
  expect(f.terminal.agent.confirmInput!('operation', 'n\n')).toBe(false);
  await expect(f.terminal.agent.execute('echo new', '/', () => true)).rejects.toThrow('human-owned');
});
