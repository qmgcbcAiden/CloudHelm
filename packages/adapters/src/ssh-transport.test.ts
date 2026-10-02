import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SshTransport, type SshHost } from './ssh-transport.js';

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

function sftpFixture(existing: boolean, afterWrite: () => void) {
  const directory = { isDirectory: () => true, isSymbolicLink: () => false };
  const file = { isDirectory: () => false, isSymbolicLink: () => false, size: 3, mode: 0o600 };
  const write = vi.fn((_path: string, _data: Buffer, _options: unknown, callback: (error: null) => void) => { afterWrite(); callback(null); });
  const rename = vi.fn((_from: string, _to: string, callback: (error: null) => void) => callback(null));
  const unlink = vi.fn((_path: string, callback: (error: null) => void) => callback(null));
  state.sftp = {
    lstat: (target: string, callback: (error: unknown, result?: unknown) => void) => {
      if (target === '/srv' || target === '/srv/app') callback(null, directory);
      else if (existing) callback(null, file);
      else callback({ code: 2 });
    },
    readFile: (_path: string, callback: (error: null, value: Buffer) => void) => callback(null, Buffer.from('old')),
    writeFile: write, ext_openssh_rename: rename, unlink, end: vi.fn()
  };
  return { write, rename, unlink };
}

describe('SFTP commit authorization', () => {
  it('does not rename or clean up a staged write after authorization is revoked', async () => {
    let authorized = true;
    const calls = sftpFixture(false, () => { authorized = false; });
    const ssh = new SshTransport(); await ssh.connect(host, { password: 'synthetic-test' });
    await expect(ssh.writeFile('host', '/srv/app/file', Buffer.from('new'), () => {
      if (!authorized) throw new Error('authorization revoked');
    })).rejects.toThrow('authorization revoked');
    expect(calls.write).toHaveBeenCalledOnce(); expect(calls.rename).not.toHaveBeenCalled(); expect(calls.unlink).not.toHaveBeenCalled();
  });

  it('does not unlink a target when takeover happens during backup creation', async () => {
    let authorized = true;
    const calls = sftpFixture(true, () => { authorized = false; });
    const ssh = new SshTransport(); await ssh.connect(host, { password: 'synthetic-test' });
    await expect(ssh.deleteFile('host', '/srv/app/file', () => {
      if (!authorized) throw new Error('taken over');
    })).rejects.toThrow('taken over');
    expect(calls.write).toHaveBeenCalledOnce(); expect(calls.unlink).not.toHaveBeenCalled();
  });

  it('makes no SFTP mutation when the final guard has already expired', async () => {
    const calls = sftpFixture(false, () => {});
    const ssh = new SshTransport(); await ssh.connect(host, { password: 'synthetic-test' });
    await expect(ssh.writeFile('host', '/srv/app/file', Buffer.from('new'), () => { throw new Error('expired'); })).rejects.toThrow('expired');
    expect(calls.write).not.toHaveBeenCalled(); expect(calls.rename).not.toHaveBeenCalled(); expect(calls.unlink).not.toHaveBeenCalled();
  });
});

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
