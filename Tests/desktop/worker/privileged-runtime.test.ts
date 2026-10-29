import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SafetyGate, TerminalManager } from '@cloudhelm/application';
import { SshTransport } from '@cloudhelm/adapters';
import { operationFingerprint, type ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { PrivilegedRuntime } from '../../../apps/desktop/src/worker/privileged-runtime.js';
import type { NativeRuntimePreparation } from '../../../apps/desktop/src/worker/native-runtime-preparation.js';

const state = vi.hoisted(() => ({ commands: [] as string[], connections: [] as unknown[][], uid: '0', fail: false, gen: 1,
  su: 0, passwords: [] as string[], close: vi.fn() }));
vi.mock('@cloudhelm/adapters', async (importOriginal) => ({
  BashAnalyzer: (await importOriginal<typeof import('@cloudhelm/adapters')>()).BashAnalyzer,
  SshTransport: class {
    connectionGeneration() { return state.gen; }
    async connect(...args: unknown[]) { state.connections.push(args); if (state.fail) throw new Error('login failed'); }
    close() { state.close(); }
  },
  SshCommandTerminal: class {
    readonly agent = this;
    data = (_value: string) => {}; exit = (_code: number) => {};
    onData(callback: typeof this.data) { this.data = callback; }
    onExit(callback: typeof this.exit) { this.exit = callback; }
    onClose() {} onDisplay() {} resize() {} write() {} close() {}
    async execute(command: string, _cwd: string, current: () => boolean) {
      if (!current()) throw new Error('expired');
      state.commands.push(command); this.data(command === 'id -u' ? `${state.uid}\n` : 'done\n'); this.exit(0);
    }
  },
  SuSession: class {
    async connect(authenticate: () => Promise<string | null>, current: () => void) {
      state.su++; const value = await authenticate(); current();
      if (value === null || state.fail) throw new Error('su failed'); state.passwords.push(value);
    }
    close() { state.close(); }
  }
}));
const host: RuntimeHost = { id: 'host', label: 'Linux', address: '192.0.2.1', port: 22, username: 'user',
  auth: 'password', secret: 'ordinary-secret', fingerprint: 'trusted', status: 'connected',
  defaultMode: 'permissive', protectedPaths: ['/etc/shadow'], policyRevision: 1 };
beforeEach(() => { state.commands = []; state.connections = []; state.uid = '0'; state.fail = false; state.gen = 1; state.su = 0; state.passwords = []; state.close.mockClear(); });
function setup(mode: 'ssh' | 'su' | 'sudo' = 'ssh') {
  const terminal = new TerminalManager({ data() {}, state() {} });
  const input = vi.fn(async (request: { kind: string }): Promise<string | null> => request.kind === 'confirmation' ? mode === 'sudo' ? '使用 sudo（推荐）' : mode === 'ssh' ? 'SSH 登录 root' : '通过 su 切换 root' : 'root-secret');
  const ordinary = { execute: vi.fn() };
  const commands = { execute: vi.fn(terminal.execute.bind(terminal)) };
  const native = { ensure: vi.fn(async () => ({ directory: '/tmp/runtime', executable: '/tmp/runtime/helper',
    artifact: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'a'.repeat(64), size: 1 } })),
    bootstrap: vi.fn(async (_operation, _plan, _gate, _transport, run: (current: () => void) => Promise<void>) => run(() => {})), retireSession: () => false };
  const runtime = new PrivilegedRuntime({ terminal, ssh: new SshTransport(), ordinary, commands,
    runtime: native as unknown as NativeRuntimePreparation, files: () => { throw new Error('No file operation allowed in fixture'); },
    jump: () => undefined, input });
  const access = runtime.forTask('task');
  const decisions: string[] = [];
  const gate = new SafetyGate({ analyzer: { analyze: async (command) => ({ raw: command, calls: [{ name: command.split(' ')[0]!, args: command.split(' ').slice(1), dynamic: false, redirects: false }],
    redirectTargets: [], hasError: false, hasCompound: false, hasPipeline: false, hasExpansion: false, hasRedirection: false }) },
    evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => true },
    executor: runtime, lease: terminal, settings: () => ({ mode: 'permissive', revision: host.policyRevision }),
    audit: { proposed: async () => {}, completed: async () => {}, decided: async (_id, decision) => { decisions.push(decision.verdict); } } });
  const request = () => access.request(host, 'mkdir -p /opt/demo', '/tmp', 'sudo unavailable', 'create demo', gate);
  const operation = (id: string, command: string): ProposedOperation => {
    const terminalId = access.terminal(id, host.id);
    return { id: 'action', kind: 'command', command, scope: { taskId: 'task', hostId: host.id, cwd: '/tmp', runAs: 'root',
      terminalId, terminalGeneration: terminal.currentGeneration(terminalId), policyRevision: 1, protectedPaths: host.protectedPaths,
      allowedWorkingRoots: ['/'], goal: 'demo', ...access.scope(terminalId) } };
  };
  return { runtime, access, gate, request, operation, input, ordinary, commands, native, terminal, decisions };
}

describe('confirmed isolated root sessions', () => {
  it('offers sudo first and prepares without authentication, identity probe or business execution', async () => {
    const f = setup('sudo'); const context = await f.request();
    expect(context).toMatchObject({ method: 'sudo', state: 'prepared', loginAs: 'user', targetRunAs: 'root', identityVerified: false });
    expect(f.input.mock.calls[0]?.[0]).toMatchObject({ choices: ['使用 sudo（推荐）', 'SSH 登录 root', '通过 su 切换 root'] });
    expect(f.input).toHaveBeenCalledOnce(); expect(state.commands).toEqual([]); expect(state.connections).toEqual([]); expect(state.su).toBe(0);
    expect(f.access.confirmed?.()).toEqual([]);
    expect(f.access.sudoContexts?.()).toEqual([{ sessionId: context.sessionId, hostId: host.id, state: 'prepared', loginAs: 'user', targetRunAs: 'root' }]);
    const plain = f.operation(context.sessionId, 'systemctl restart demo');
    const prepared = await f.access.prepare!(plain);
    expect(prepared).toMatchObject({ command: 'sudo -- systemctl restart demo', scope: { runAs: 'root', loginAs: 'user' } });
    expect(operationFingerprint(prepared)).not.toBe(operationFingerprint(plain));
    await expect(f.runtime.forTask('other').prepare!({ ...prepared, scope: { ...prepared.scope, taskId: 'other' } })).rejects.toThrow();
    await expect(f.access.prepare!({ ...prepared, scope: { ...prepared.scope, hostId: 'other-host' } })).rejects.toThrow();
    await expect(f.gate.execute(plain)).resolves.toMatchObject({ result: { status: 'failed', failureKind: 'unsupported', effects: 'none' } });
    expect(f.ordinary.execute).not.toHaveBeenCalled();
    f.ordinary.execute.mockResolvedValue({ operationId: 'action', status: 'succeeded', exitCode: 0, stdoutTail: 'done' });
    expect((await f.gate.execute(prepared)).result?.status).toBe('succeeded');
    expect(f.ordinary.execute.mock.calls[0]?.[0]).toMatchObject({ command: 'sudo -- systemctl restart demo' });
    state.gen++; expect(f.access.sudoContexts?.()).toEqual([]);
    await expect(f.access.prepare!(prepared)).rejects.toThrow(); f.access.close();
  });
  it('does not elevate SFTP through a sudo context or accept compound/root-changing commands', async () => {
    const f = setup('sudo'); const context = await f.request();
    for (const command of ['id; whoami', 'sudo -u other id', 'su root', 'sudo -n true'])
      await expect(f.access.prepare!(f.operation(context.sessionId, command))).rejects.toThrow();
    const base = f.operation(context.sessionId, 'id');
    const write: ProposedOperation = { id: 'file', kind: 'write-file', path: '/opt/demo/file', content: 'x', scope: base.scope };
    await expect(f.access.prepare!(write)).rejects.toThrow('Structured file transactions require');
    const result = await f.gate.execute(write);
    expect(result.result).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'unsupported' });
    expect(f.ordinary.execute).not.toHaveBeenCalled(); f.access.close();
  });
  it('projects only confirmed, owned, current-generation sessions without credentials or cross-task references', async () => {
    const f = setup();
    expect(f.access.confirmed?.()).toEqual([]);
    const session = await f.request();
    const projection = f.access.confirmed?.();
    expect(projection).toEqual([{ sessionId: session.sessionId, hostId: host.id, method: 'ssh', runAs: 'root' }]);
    expect(JSON.stringify(projection)).not.toContain('secret');
    expect(f.runtime.forTask('other').confirmed?.()).toEqual([]);
    state.gen++;
    expect(f.access.confirmed?.()).toEqual([]);
    state.gen--;
    f.terminal.takeOver(f.access.terminal(session.sessionId, host.id));
    expect(f.access.confirmed?.()).toEqual([]);
    f.access.close();
  });

  it.each(['ssh', 'su'] as const)('authenticates %s, verifies UID, and reviews subsequent operations', async (mode) => {
    const f = setup(mode); const session = await f.request();
    expect(state.commands).toEqual(['id -u']);
    expect(JSON.stringify(session)).not.toContain('secret');
    const operation = f.operation(session.sessionId, 'mkdir -p /opt/demo');
    expect(operation.scope).toMatchObject({ loginAs: mode === 'ssh' ? 'root' : 'user', runAs: 'root', sessionId: session.sessionId, connectionGeneration: 1 });
    expect((await f.gate.execute(operation)).result?.status).toBe('succeeded');
    expect((await f.gate.execute(f.operation(session.sessionId, 'cat /etc/shadow'))).decision.verdict).toBe('deny');
    expect(state.commands).toEqual(['id -u', 'mkdir -p /opt/demo']);
    expect(f.commands.execute).toHaveBeenCalledTimes(2);
    expect(f.native.ensure).toHaveBeenCalledOnce();
    expect(f.native.bootstrap).toHaveBeenCalledTimes(mode === 'su' ? 1 : 0);
    expect(f.ordinary.execute).not.toHaveBeenCalled();
    if (mode === 'ssh') {
      expect(state.connections[0]?.[0]).toMatchObject({ username: 'root', id: host.id, fingerprint: 'trusted', address: host.address, secret: undefined });
      expect(state.connections[0]?.[1]).toEqual({ password: 'root-secret', passphrase: 'root-secret' });
    } else expect(state.passwords).toEqual(['root-secret']);
    f.access.close();
  });
  it.each(['ssh', 'su'] as const)('does not execute payload after failed %s authentication', async (mode) => {
    const f = setup(mode); state.fail = true;
    await expect(f.request()).rejects.toThrow(mode === 'su' ? 'su failed' : 'identity'); expect(state.commands).toEqual([]);
  });
  it('rejects a non-root identity', async () => {
    const f = setup(); state.uid = '1000'; await expect(f.request()).rejects.toThrow('identity');
    expect(state.commands).toEqual(['id -u']); expect(state.close).toHaveBeenCalled();
  });
  it('expires on pause and binds approvals to identity and connection', async () => {
    const f = setup(); const session = await f.request(); const op = f.operation(session.sessionId, 'id');
    const hash = operationFingerprint(op);
    expect(operationFingerprint({ ...op, scope: { ...op.scope, sessionId: 'different' } })).not.toBe(hash);
    expect(operationFingerprint({ ...op, scope: { ...op.scope, connectionGeneration: 2 } })).not.toBe(hash);
    expect(() => f.runtime.forTask('other').terminal(session.sessionId, host.id)).toThrow();
    f.access.close();
    expect(f.terminal.hostOf(op.scope.terminalId)).toBeUndefined();
    expect(() => f.access.terminal(session.sessionId, host.id)).toThrow('expired');
    expect((await f.gate.execute(op)).decision.verdict).toBe('error');
  });
  it('rejects source reconnection and never reuses a stale session', async () => {
    const f = setup(); const session = await f.request(); const op = f.operation(session.sessionId, 'id');
    state.gen++; expect((await f.gate.execute(op)).result?.status).toBe('unknown');
    expect(state.commands).toEqual(['id -u']); f.access.close();
  });
  it('cancels pending confirmation and rejects duplicate requests', async () => {
    const f = setup(); let answer!: (value: string) => void;
    f.input.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const pending = f.request(); await expect(f.request()).rejects.toThrow('already pending');
    f.access.close(); answer('SSH 登录 root'); await expect(pending).rejects.toThrow();
    expect(state.connections).toEqual([]); expect(state.commands).toEqual([]);
  });
  it('keeps su file operations out of ordinary SFTP', async () => {
    const f = setup('su'); const session = await f.request(); const base = f.operation(session.sessionId, 'id');
    const write: ProposedOperation = { id: 'file', kind: 'write-file', path: '/opt/demo/file', content: 'value', scope: base.scope };
    expect((await f.gate.execute(write)).result).toMatchObject({ status: 'failed', failureKind: 'unsupported', effects: 'none' });
    expect(f.ordinary.execute).not.toHaveBeenCalled(); f.access.close();
  });
});
