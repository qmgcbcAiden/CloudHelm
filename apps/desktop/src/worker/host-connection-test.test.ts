import { generateKeyPairSync } from 'node:crypto';
import { Server } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HostKeyError, SshTransport } from '@cloudhelm/adapters';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { testHostConnection } from './host-connection-test.js';

const host: RuntimeHost = { id: 'test', label: 'Fixture', address: '127.0.0.1', port: 22, username: 'fixture', auth: 'password',
  secret: 'synthetic-password', status: 'disconnected', protectedPaths: [], defaultMode: 'ai-review', policyRevision: 1 };

describe('isolated SSH test cleanup and reporting', () => {
  it.each([undefined, new Error('Authentication failed password=do-not-return'), new HostKeyError('SHA256:fixture')])(
    'always closes its private transport and returns only structured diagnostics', async (failure) => {
      const ssh = { connect: vi.fn(async () => { if (failure) throw failure; }), close: vi.fn() };
      const result = await testHostConnection(host, undefined, () => ssh);
      expect(ssh.close).toHaveBeenCalledOnce();
      expect(result.status).toBe(failure instanceof HostKeyError ? 'trust-required' : failure ? 'failed' : 'success');
      expect(JSON.stringify(result)).not.toContain('do-not-return');
    });

  it('identifies a jump failure without attempting the target', async () => {
    const ssh = { connect: vi.fn(async () => { throw new HostKeyError('SHA256:jump'); }), close: vi.fn() };
    const result = await testHostConnection(host, { ...host, id: 'jump' }, () => ssh);
    expect(result).toMatchObject({ status: 'trust-required', stage: 'jump' });
    expect(ssh.connect).toHaveBeenCalledOnce(); expect(ssh.close).toHaveBeenCalledOnce();
  });
});

describe('connection test against a real local SSH handshake', () => {
  let server: Server;
  let fixture: RuntimeHost;
  let sessions = 0;
  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
    server = new Server({ hostKeys: [privateKey] }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (context) => {
        if (context.method === 'password' && context.username === host.username && context.password === host.secret) context.accept();
        else context.reject(['password']);
      });
      client.on('session', (_accept, reject) => { sessions += 1; reject(); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local server port');
    fixture = { ...host, port: address.port };
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('requires fingerprint verification, authenticates, and never opens a shell', async () => {
    const first = await testHostConnection(fixture);
    expect(first.status).toBe('trust-required');
    if (first.status !== 'trust-required') throw new Error('Expected fingerprint');
    fixture.fingerprint = first.fingerprint;
    const result = await testHostConnection(fixture);
    expect(result.status).toBe('success'); expect(sessions).toBe(0);
  });

  it('reports bad passwords and leaves another connection untouched', async () => {
    const existing = new SshTransport();
    try {
      await existing.connect(fixture, { password: fixture.secret });
      const generation = existing.connectionGeneration(fixture.id);
      expect(await testHostConnection({ ...fixture, secret: 'wrong-password' })).toEqual({ status: 'failed', code: 'auth', stage: 'host' });
      expect(existing.isConnected(fixture.id)).toBe(true);
      expect(existing.connectionGeneration(fixture.id)).toBe(generation);
    } finally { existing.close(); }
  });
});
