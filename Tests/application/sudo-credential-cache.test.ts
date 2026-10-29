import { afterEach, describe, expect, it, vi } from 'vitest';
import { SudoCredentialCache } from '../../packages/application/src/sudo-credential-cache.js';
const binding = { taskId: 'task', hostId: 'host', terminalId: 'terminal', terminalGeneration: 1,
  connectionGeneration: 1, policyRevision: 1, cachePolicyRevision: 1, prompt: '[sudo] password for user:', loginAs: 'user', runAs: 'root' };
afterEach(() => vi.useRealTimers());
describe('task-scoped verified sudo credential cache', () => {
  it('binds credentials to the task, host, identities, policy and both generations', () => {
    const cache = new SudoCredentialCache(); const buffer = Buffer.from('private-fixture');
    cache.remember(binding, buffer); buffer.fill(0); expect(cache.read(binding)).toBe('private-fixture');
    for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
      cache.remember(binding, Buffer.from('private-fixture'));
      const value = binding[key]; expect(cache.read({ ...binding, [key]: typeof value === 'number' ? value + 1 : value + '-other' })).toBeUndefined();
    }
    cache.clearTask('task'); expect(cache.read(binding)).toBeUndefined();
  });
  it('forgets a mismatched full prompt permanently, even if its display prefix was identical', () => {
    const cache = new SudoCredentialCache();
    const long = { ...binding, prompt: 'a'.repeat(300) + 'password' };
    cache.remember(long, Buffer.from('fixture'));
    expect(cache.read({ ...long, prompt: 'a'.repeat(300) + 'OTP' })).toBeUndefined();
    expect(cache.read(long)).toBeUndefined();
  });
  it('clears all credentials for a host without clearing unrelated hosts', () => {
    const cache = new SudoCredentialCache();
    cache.remember(binding, Buffer.from('fixture'));
    cache.remember({ ...binding, hostId: 'other' }, Buffer.from('other'));
    cache.clearHost('host');
    expect(cache.read(binding)).toBeUndefined();
    expect(cache.read({ ...binding, hostId: 'other' })).toBe('other');
    cache.clearHost('other');
  });
  it('expires after five minutes without sliding the expiry on reads', () => {
    vi.useFakeTimers(); const cache = new SudoCredentialCache(); cache.remember(binding, Buffer.from('fixture'));
    vi.advanceTimersByTime(299_999); expect(cache.read(binding)).toBe('fixture');
    vi.advanceTimersByTime(2); expect(cache.read(binding)).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it('clears a terminal independently and replaces an old verified value', () => {
    const cache = new SudoCredentialCache(); cache.remember(binding, Buffer.from('old'));
    cache.remember(binding, Buffer.from('new')); cache.remember({ ...binding, taskId: 'other', terminalId: 'other' }, Buffer.from('other'));
    expect(cache.read(binding)).toBe('new'); cache.clearTerminal('terminal'); expect(cache.read(binding)).toBeUndefined();
    expect(cache.read({ ...binding, taskId: 'other', terminalId: 'other' })).toBe('other'); cache.clearTask('other');
  });
});
