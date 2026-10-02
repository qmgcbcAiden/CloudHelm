import { describe, expect, it, vi } from 'vitest';
import type { HostConnectionTestInput, HostView } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeHostTestResult } from '@cloudhelm/contracts/runtime';
import { HostConnectionTester } from './host-connection-test.js';

const saved: HostView = { id: 'saved', label: 'Server', address: 'host.test', port: 22, username: 'ubuntu', auth: 'password',
  fingerprint: 'SHA256:old', status: 'connected', protectedPaths: [], policyRevision: 1, defaultMode: 'ai-review' };
function setup() {
  const source = {
    getHost: vi.fn((id: string) => ({ ...saved, id })),
    runtimeHost: vi.fn((id: string) => ({ ...saved, id, secret: 'saved-credential' }))
  };
  const run = vi.fn(async (_host: RuntimeHost, _jump?: RuntimeHost): Promise<RuntimeHostTestResult> => ({ status: 'success', latencyMs: 12 }));
  const tester = new HostConnectionTester(source, run);
  const input: HostConnectionTestInput = { host: { ...saved }, editingHostId: 'saved' };
  return { source, run, tester, input };
}

describe('unsaved host connection tests', () => {
  it('uses the draft with an isolated identity and reuses credentials only for the unchanged destination', async () => {
    const { tester, run, input, source } = setup();
    const result = await tester.test(input);
    expect(result).toEqual({ status: 'success', latencyMs: 12 });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-target', status: 'disconnected', secret: 'saved-credential' }), undefined);
    expect(source.getHost('saved').status).toBe('connected');
    expect(JSON.stringify(result)).not.toContain('credential');
  });

  it.each([{ address: 'another.test' }, { username: 'root' }, { port: 2222 }, { auth: 'private-key' as const }, { privateKeyPath: '/different/key' }])(
    'does not reuse stored credentials after destination or authentication changes: %j', async (change) => {
      const { tester, run, input, source } = setup();
      input.host = { ...input.host, ...change };
      await tester.test(input);
      expect(run.mock.calls[0]![0].secret).toBeUndefined();
      expect(source.runtimeHost).not.toHaveBeenCalled();
    });

  it('does not accept a renderer-supplied fingerprint for a new destination', async () => {
    const { tester, run, input } = setup();
    input.host.address = 'another.test'; input.secret = 'new-credential';
    await tester.test(input);
    expect(run.mock.calls[0]![0]).toMatchObject({ address: 'another.test', secret: 'new-credential' });
    expect(run.mock.calls[0]![0].fingerprint).toBeUndefined();
  });

  it('binds a single-use temporary trust decision to the exact tested draft', async () => {
    const { tester, run, input } = setup();
    run.mockResolvedValueOnce({ status: 'trust-required', stage: 'host', fingerprint: 'SHA256:new', expectedFingerprint: 'SHA256:old' });
    const result = await tester.test(input);
    expect(result.status).toBe('trust-required');
    if (result.status !== 'trust-required') throw new Error('Expected challenge');
    expect(result.address).toBe(saved.address);
    await tester.test({ ...input, trustRequestId: result.requestId });
    expect(run.mock.calls[1]![0].fingerprint).toBe('SHA256:new');
    await expect(tester.test({ ...input, trustRequestId: result.requestId })).rejects.toThrow('confirmation expired');
    await tester.test(input);
    expect(run.mock.calls[2]![0].fingerprint).toBe('SHA256:old');
  });

  it.each(['configuration', 'secret', 'expiry'])('invalidates trust on %s changes', async (change) => {
    const { tester, run, input } = setup();
    run.mockResolvedValueOnce({ status: 'trust-required', stage: 'host', fingerprint: 'SHA256:new' });
    const result = await tester.test(input);
    if (result.status !== 'trust-required') throw new Error('Expected challenge');
    if (change === 'configuration') input.host.port = 2222;
    if (change === 'secret') input.secret = 'different';
    const clock = change === 'expiry' ? vi.spyOn(Date, 'now').mockReturnValue(result.expiresAt + 1) : undefined;
    try { await expect(tester.test({ ...input, trustRequestId: result.requestId })).rejects.toThrow('confirmation expired'); }
    finally { clock?.mockRestore(); }
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps jump and target trust decisions separate across both confirmations', async () => {
    const { tester, run, input } = setup();
    input.host.jumpHostId = 'jump'; input.secret = 'typed-credential';
    run.mockResolvedValueOnce({ status: 'trust-required', stage: 'jump', fingerprint: 'SHA256:jump' });
    const jump = await tester.test(input);
    if (jump.status !== 'trust-required') throw new Error('Expected challenge');
    run.mockResolvedValueOnce({ status: 'trust-required', stage: 'host', fingerprint: 'SHA256:target' });
    const target = await tester.test({ ...input, trustRequestId: jump.requestId });
    if (target.status !== 'trust-required') throw new Error('Expected challenge');
    await tester.test({ ...input, trustRequestId: target.requestId });
    expect(run.mock.calls[2]![0].fingerprint).toBe('SHA256:target');
    expect(run.mock.calls[2]![1]?.fingerprint).toBe('SHA256:jump');
  });

  it('rejects invalid input and self-referencing jump hosts before any network call', async () => {
    const { tester, run, input } = setup();
    await expect(tester.test({ ...input, host: { ...input.host, port: 0 } })).rejects.toThrow('Invalid host settings');
    await expect(tester.test({ ...input, host: { ...input.host, jumpHostId: 'saved' } })).rejects.toThrow('direct host');
    expect(run).not.toHaveBeenCalled();
  });
});
