import type { OperationScope } from '@cloudhelm/core';

type Binding = Pick<OperationScope, 'taskId' | 'hostId' | 'terminalId' | 'terminalGeneration' | 'policyRevision' | 'runAs' | 'loginAs'>
  & { connectionGeneration: number; cachePolicyRevision: number; prompt: string };
interface Entry { binding: Binding; secret: Buffer; timer: ReturnType<typeof setTimeout>; expiresAt: number }

/** Runtime-only, verified credentials. Never include this object's contents in diagnostics. */
export class SudoCredentialCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly ttlMs = 5 * 60_000) {}
  private key(binding: Binding): string {
    return JSON.stringify([binding.taskId, binding.hostId, binding.terminalId, binding.terminalGeneration,
      binding.connectionGeneration, binding.policyRevision, binding.cachePolicyRevision, binding.loginAs, binding.runAs]);
  }
  read(binding: Binding): string | undefined {
    const key = this.key(binding); const entry = this.entries.get(key);
    if (!entry) return;
    if (!binding.prompt || entry.binding.prompt !== binding.prompt || entry.expiresAt <= Date.now()) { this.remove(key); return; }
    return entry.secret.toString('utf8');
  }
  remember(binding: Binding, secret: Buffer): void {
    if (!binding.prompt || !Number.isSafeInteger(binding.cachePolicyRevision) || binding.cachePolicyRevision < 1) return;
    const key = this.key(binding); this.remove(key);
    const timer = setTimeout(() => this.remove(key), this.ttlMs); timer.unref?.();
    this.entries.set(key, { binding: { ...binding }, secret: Buffer.from(secret), timer, expiresAt: Date.now() + this.ttlMs });
  }
  forget(binding: Binding): void { this.remove(this.key(binding)); }
  clearTask(taskId: string): void { for (const [key, entry] of this.entries) if (entry.binding.taskId === taskId) this.remove(key); }
  clearTerminal(terminalId: string): void { for (const [key, entry] of this.entries) if (entry.binding.terminalId === terminalId) this.remove(key); }
  clearHost(hostId: string): void { for (const [key, entry] of this.entries) if (entry.binding.hostId === hostId) this.remove(key); }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer); entry.secret.fill(0); this.entries.delete(key);
  }
}
