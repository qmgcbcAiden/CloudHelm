import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { SuSession } from '../../packages/adapters/src/su-session.js';
import type { SshTransport } from '../../packages/adapters/src/ssh-transport.js';
class Broker extends EventEmitter {
  stderr = new EventEmitter(); writes: string[] = [];
  write(value: string): void { this.writes.push(value); }
  end(): void {} close(): void { this.emit('close'); }
  event(value: Record<string, unknown>): void { this.emit('data', Buffer.from(`${JSON.stringify({ version: 1, operationId: 'connect-op', sessionId: 'root-session', generation: 1, ...value })}\n`)); }
}
const context = { version: 1 as const, operationId: 'connect-op', sessionId: 'root-session', generation: 1, rootDirectory: '/tmp/cloudhelm-root-fixture', artifactSha256: 'a'.repeat(64) };
function fixture() {
  const broker = new Broker(), controller = new AbortController(), closed = vi.fn();
  const ssh = { connectionGeneration: () => 1, prepareCommandProgram: async () => '/tmp/fixture/helper',
    removeCommandProgram: async () => {}, openPipe: async () => broker } as unknown as SshTransport;
  const session = new SuSession(ssh, 'host', controller.signal, closed);
  const connect = session.connect.bind(session); session.connect = (authenticate, current) => connect(authenticate, current, context);
  return { broker, controller, session, closed, listening: () => vi.waitFor(() => expect(broker.listenerCount('data')).toBe(1)) };
}
it.each(['timeout', 'unsupported', 'cancelled', 'authentication-unconfirmed', 'transport-unavailable'] as const)(
  'preserves safe su protocol code %s without echoing remote bodies', async (code) => {
    const f = fixture(); const pending = f.session.connect(async () => 'synthetic-only', () => {});
    const check = expect(pending).rejects.toMatchObject({ feedback: { method: 'su', code, businessCommand: 'not-started', source: 'transport' } });
    await f.listening(); f.broker.event({ type: 'error', code, detail: 'private-untrusted-body' }); await check;
    expect(f.closed).toHaveBeenCalledOnce(); expect(f.broker.writes).toHaveLength(1); expect(JSON.parse(f.broker.writes[0]!)).toMatchObject({ type: 'connect' });
    await expect(f.session.openPipe()).rejects.toThrow('expired');
  });
it('rejects cancellation promptly and discards a late credential', async () => {
  const f = fixture(); let answer!: (value: string) => void;
  const pending = f.session.connect(() => new Promise((resolve) => { answer = resolve; }), () => {});
  const check = expect(pending).rejects.toMatchObject({ feedback: { code: 'cancelled' } });
  await f.listening(); f.broker.event({ type: 'auth', id: 'a'.repeat(32) });
  f.controller.abort(); answer('late-synthetic-password'); await check;
  expect(f.broker.writes).toHaveLength(1); expect(JSON.parse(f.broker.writes[0]!)).toMatchObject({ type: 'connect' }); expect(f.closed).toHaveBeenCalledOnce();
});

it('rechecks the bootstrap grant after authentication UI resolves', async () => {
  const f = fixture(); let authorized = true; let answer!: (value: string) => void;
  const pending = f.session.connect(() => new Promise((resolve) => { answer = resolve; }), () => {
    if (!authorized) throw new Error('Bootstrap policy revision changed');
  });
  const rejected = expect(pending).rejects.toMatchObject({ feedback: { code: 'authentication-unconfirmed' } });
  await f.listening(); f.broker.event({ type: 'auth', id: 'a'.repeat(32) });
  authorized = false; answer('late-synthetic-password'); await rejected;
  expect(f.broker.writes.map((frame) => JSON.parse(frame).type)).toEqual(['connect']);
  expect(f.closed).toHaveBeenCalledOnce();
});
it('does not label arbitrary stderr or malformed protocol as a wrong password', async () => {
  const f = fixture(); const pending = f.session.connect(async () => null, () => {});
  const check = expect(pending).rejects.toMatchObject({ feedback: { code: 'unsupported' } });
  await f.listening(); f.broker.stderr.emit('data', Buffer.from('private-untrusted-body')); await check;
});
it('validates root UID and never forwards an answer after the root channel is ready', async () => {
  const f = fixture(); let answer!: (value: string) => void;
  const pending = f.session.connect(() => new Promise((resolve) => { answer = resolve; }), () => {});
  await f.listening(); f.broker.event({ type: 'auth', id: 'a'.repeat(32) }); f.broker.event({ type: 'ready', uid: 0, euid: 0, rootDirectory: context.rootDirectory }); await pending;
  answer('late-synthetic-password'); await Promise.resolve(); expect(f.broker.writes).toHaveLength(1); expect(JSON.parse(f.broker.writes[0]!)).toMatchObject({ type: 'connect' }); f.session.close();
  const bad = fixture(); const rejected = bad.session.connect(async () => null, () => {});
  const check = expect(rejected).rejects.toMatchObject({ feedback: { code: 'authentication-unconfirmed' } });
  await bad.listening(); bad.broker.event({ type: 'ready', uid: 1000 }); await check;
});

it('requires an approved root-copy context before opening the broker', async () => { const ssh = { connectionGeneration: () => 1, openPipe: vi.fn() } as unknown as SshTransport; const session = new SuSession(ssh, 'h', new AbortController().signal, () => {}); await expect(session.connect(async () => null, () => {})).rejects.toMatchObject({ feedback: { businessCommand: 'not-started' } }); expect(ssh.openPipe).not.toHaveBeenCalled(); });

it('carries a bounded base64 file response larger than 1 MiB through the root channel', async () => {
  const f = fixture(); const pending = f.session.connect(async () => null, () => {});
  await f.listening(); f.broker.event({ type: 'ready', uid: 0, euid: 0, rootDirectory: context.rootDirectory }); await pending;
  const channel = await f.session.openPipe('host', 'fixed-root-command-program --files');
  const data = JSON.stringify({ type: 'file-result', result: { contentBase64: Buffer.alloc(1_048_576).toString('base64') } }) + '\n';
  let received = ''; channel.on('data', (chunk: Buffer) => { received += chunk.toString('utf8'); });
  f.broker.event({ type: 'output', data });
  await vi.waitFor(() => expect(received).toBe(data));
  expect(f.closed).not.toHaveBeenCalled(); f.session.close();
});

it('requires a current cleanup grant and waits for the exact confirmed root copy', async () => {
  const f = fixture(); const pending = f.session.connect(async () => null, () => {});
  await f.listening(); f.broker.event({ type: 'ready', uid: 0, euid: 0, rootDirectory: context.rootDirectory }); await pending;
  await expect(f.session.cleanupRuntime(() => { throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(f.broker.writes).toHaveLength(1);
  const cleanup = f.session.cleanupRuntime(() => {});
  expect(JSON.parse(f.broker.writes[1]!)).toMatchObject({ type: 'cleanup', rootDirectory: context.rootDirectory, sha256: context.artifactSha256 });
  f.broker.event({ type: 'cleanup-confirmed', rootDirectory: context.rootDirectory, sha256: context.artifactSha256 });
  await cleanup;
  await expect(f.session.openPipe()).rejects.toThrow('expired');
  f.session.close();
});

it('does not delete the root copy when the session closes without cleanup approval', async () => {
  const f = fixture(); const pending = f.session.connect(async () => null, () => {});
  await f.listening(); f.broker.event({ type: 'ready', uid: 0, euid: 0, rootDirectory: context.rootDirectory }); await pending;
  f.session.close();
  expect(f.broker.writes.map((value) => JSON.parse(value).type)).toEqual(['connect']);
});
