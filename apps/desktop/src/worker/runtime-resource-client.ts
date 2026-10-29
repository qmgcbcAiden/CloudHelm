import { randomUUID } from 'node:crypto';
import type { RuntimeResourceRequest, RuntimeResourceResult, RuntimeResourceView } from '@cloudhelm/contracts';
export class RuntimeResourceClient {
  private readonly pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly send: (message: RuntimeResourceRequest) => void) {}
  commit(record: RuntimeResourceView): Promise<void> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Runtime resource journal acknowledgment unavailable')); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ runtimeResourceRequest: { id, record } }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('Runtime resource journal unavailable')); }
    });
  }
  receive(result: RuntimeResourceResult['runtimeResourceResult']): void {
    const pending = this.pending.get(result.id); if (!pending) return;
    this.pending.delete(result.id); clearTimeout(pending.timer);
    if (result.error) pending.reject(new Error('Runtime resource journal rejected the change')); else pending.resolve();
  }
}
