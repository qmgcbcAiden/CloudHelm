import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SshTransport, type SshHost } from './ssh-transport.js';

const fixture = vi.hoisted(() => ({ ready: false, clients: [] as Array<{ end: ReturnType<typeof vi.fn>; emit(event: string): boolean }>,
  forward: undefined as undefined | ((error: null, channel: { end(): void }) => void) }));
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  return { Client: class extends EventEmitter {
    end = vi.fn();
    constructor() { super(); fixture.clients.push(this); }
    connect(): void { if (fixture.ready) queueMicrotask(() => this.emit('ready')); }
    forwardOut(_origin: string, _port: number, _host: string, _targetPort: number, callback: typeof fixture.forward): void { fixture.forward = callback; }
  } };
});
const host: SshHost = { id: 'target', label: 'Target', address: 'localhost', port: 22, username: 'user', auth: 'password' };
beforeEach(() => { fixture.clients = []; fixture.ready = false; fixture.forward = undefined; });

describe('SSH test deadline cleanup', () => {
  it('ends a pending handshake and never registers a late ready connection', async () => {
    const ssh = new SshTransport(); const abort = new AbortController();
    const connection = ssh.connect(host, { password: 'test-only' }, undefined, undefined, abort.signal);
    const outcome = expect(connection).rejects.toThrow('timed out');
    abort.abort(); await outcome;
    expect(fixture.clients[0]!.end).toHaveBeenCalled();
    fixture.clients[0]!.emit('ready');
    expect(ssh.isConnected(host.id)).toBe(false);
  });

  it('stops waiting for jump forwarding and closes a channel delivered after timeout', async () => {
    fixture.ready = true;
    const ssh = new SshTransport(); const abort = new AbortController();
    const connection = ssh.connect(host, { password: 'test-only' }, { host: { ...host, id: 'jump' }, secret: { password: 'test-only' } }, undefined, abort.signal);
    const outcome = expect(connection).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(fixture.forward).toBeDefined());
    abort.abort(); await outcome;
    const lateChannel = { end: vi.fn() }; fixture.forward!(null, lateChannel);
    expect(lateChannel.end).toHaveBeenCalledOnce();
    ssh.close(); expect(fixture.clients[0]!.end).toHaveBeenCalled();
    expect(ssh.isConnected(host.id)).toBe(false);
  });
});
