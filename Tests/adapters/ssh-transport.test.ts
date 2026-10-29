import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SshTransport, type SshHost } from '../../packages/adapters/src/ssh-transport.js';

const state = vi.hoisted(() => ({ clients: [] as Array<{ emit(event: string, ...args: unknown[]): boolean; end: ReturnType<typeof vi.fn> }>, sftp: {} as Record<string, unknown> }));
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  return { Client: class extends EventEmitter {
    end = vi.fn();
    constructor() { super(); state.clients.push(this); }
    connect(): void { queueMicrotask(() => this.emit('ready')); }
    sftp(callback: (error: null, sftp: unknown) => void): void { callback(null, state.sftp); }
    forwardOut(_host: string, _port: number, _address: string, _remotePort: number, callback: (error: null, socket: unknown) => void): void { callback(null, {}); }
  } };
});
const host: SshHost = { id: 'host', label: 'test', address: 'localhost', port: 22, username: 'test', auth: 'password', fingerprint: 'test' };
beforeEach(() => { state.clients.length = 0; state.sftp = {}; });

describe('SSH connection generations', () => {
  it('invalidates only the active connection and ignores stale close events', async () => {
    const disconnected = vi.fn(); const ssh = new SshTransport(disconnected);
    await ssh.connect(host, { password: 'synthetic-test' }); const old = state.clients[0]!;
    await ssh.connect(host, { password: 'synthetic-test' }); const generation = ssh.connectionGeneration('host');
    expect(disconnected).toHaveBeenCalledTimes(1);
    old.emit('close');
    expect(ssh.isConnected('host')).toBe(true); expect(ssh.connectionGeneration('host')).toBe(generation);
    state.clients[1]!.emit('close');
    expect(ssh.isConnected('host')).toBe(false); expect(ssh.connectionGeneration('host')).toBe(generation + 1);
    expect(disconnected).toHaveBeenCalledTimes(2);
  });

  it('handles post-ready errors and explicit disconnect without an unhandled error', async () => {
    const disconnected = vi.fn(); const ssh = new SshTransport(disconnected);
    await ssh.connect(host, { password: 'synthetic-test' });
    expect(() => state.clients[0]!.emit('error', new Error('connection lost'))).not.toThrow();
    expect(state.clients[0]!.end).toHaveBeenCalledOnce();
    ssh.disconnect('host'); state.clients[0]!.emit('close');
    expect(disconnected).toHaveBeenCalledOnce(); expect(ssh.isConnected('host')).toBe(false);
  });

  it('registers jump host lifecycle with its own generation and disconnect event', async () => {
    const disconnected = vi.fn(); const ssh = new SshTransport(disconnected);
    await ssh.connect(host, { password: 'synthetic-test' }, { host: { ...host, id: 'jump' }, secret: { password: 'synthetic-test' } });
    expect(ssh.connectionGeneration('jump')).toBe(1);
    state.clients[0]!.emit('close');
    expect(disconnected).toHaveBeenCalledWith('jump'); expect(ssh.isConnected('jump')).toBe(false);
    expect(ssh.isConnected('host')).toBe(true);
  });
});

it('requires a previously authorized native runtime rather than preparing a Python helper', async () => {
  const ssh = new SshTransport(); await ssh.connect(host, { password: 'synthetic-test' });
  const fixed = vi.spyOn(ssh, 'execFixed');
  await expect(ssh.prepareCommandProgram('host', 'fixed', () => {})).rejects.toThrow('authorized native runtime');
  expect(fixed).not.toHaveBeenCalled();
  expect('writeFile' in ssh).toBe(false); expect('deleteFile' in ssh).toBe(false);
});
