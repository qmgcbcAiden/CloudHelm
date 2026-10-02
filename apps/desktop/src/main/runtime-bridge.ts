import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { RuntimeCall, RuntimeMessage } from '@cloudhelm/contracts/runtime';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class RuntimeBridge {
  private stopped = false;
  private closing = false;
  private readonly child: UtilityProcess;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly onEvent: (event: Extract<RuntimeMessage, { event: unknown }>['event']) => void,
    private readonly readLog: (taskId: string, operationId: string, cursor: number) => import('@cloudhelm/contracts/runtime').LogPage,
    private readonly onStopped: () => void = () => {}) {
    this.child = utilityProcess.fork(join(import.meta.dirname, 'runtime.js'), [], { serviceName: 'CloudHelm Agent and SSH runtime' });
    this.child.on('message', (message: RuntimeMessage) => this.receive(message));
    this.child.on('exit', () => {
      this.stopped = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Agent runtime stopped; remote command outcomes require verification'));
      }
      this.pending.clear();
      if (!this.closing) this.onStopped();
    });
  }

  async call<T = unknown>(call: RuntimeCall): Promise<T> {
    if (this.stopped) throw new Error('AI 运行进程已停止，请重新打开 CloudHelm 并核验远端状态。');
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Runtime request timed out'));
      }, call.method === 'connect' ? 180_000 : call.method === 'test-host' ? 60_000 : 30_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      this.child.postMessage({ id, call });
    });
  }

  private receive(message: RuntimeMessage): void {
    if ('readLog' in message) {
      const query = message.readLog;
      try { this.child.postMessage({ logResult: { id: query.id, value: this.readLog(query.taskId, query.operationId, query.cursor) } }); }
      catch { this.child.postMessage({ logResult: { id: query.id, error: 'Log unavailable' } }); }
      return;
    }
    if ('event' in message) { this.onEvent(message.event); return; }
    if (!('id' in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if ('error' in message && message.error) {
      const error = new Error(message.error) as Error & { hostFingerprint?: string };
      if (message.hostFingerprint) error.hostFingerprint = message.hostFingerprint;
      pending.reject(error);
    } else pending.resolve('result' in message ? message.result : undefined);
  }

  close(): void { this.closing = true; this.child.kill(); }
}
