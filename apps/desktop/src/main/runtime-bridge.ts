import type { DiagnosticEvent } from '@cloudhelm/core';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
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
    private readonly onStopped: () => void = () => {},
    private readonly diagnostic: (event: DiagnosticEvent) => void = () => {},
    private readonly requestBudget?: (command: unknown) => import('@cloudhelm/contracts').BudgetOutcome,
    private readonly fileJournal?: (command: unknown) => { record?: import('@cloudhelm/contracts').FileTransactionViewRecord; error?: string },
    private readonly runtimeResource?: (record: unknown) => void,
    private readonly filePreview?: (value: unknown) => void) {
    this.child = utilityProcess.fork(join(import.meta.dirname, 'runtime.js'), [], { serviceName: 'CloudHelm Agent and SSH runtime', env: { ...process.env,
      CLOUDHELM_NATIVE_DIR: app.isPackaged ? join(process.resourcesPath, 'native') : join(import.meta.dirname, '../../resources/native') } });
    this.child.on('message', (message: RuntimeMessage) => this.receive(message));
    this.child.on('exit', () => {
      if (this.stopped) return;
      this.stopped = true;
      this.rejectPending();
      if (!this.closing) this.onStopped();
    });
  }

  async call<T = unknown>(call: RuntimeCall): Promise<T> {
    if (this.stopped || this.closing) throw new Error('AI 运行进程已停止，请重新打开 CloudHelm 并核验远端状态。');
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Runtime request timed out'));
      }, call.method === 'prepare-message' || call.method === 'request-ai-denial-review' || call.method === 'recover-file-transaction' ? 650_000
        : call.method === 'connect' ? 180_000 : call.method === 'test-host' ? 60_000 : 30_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      try { this.child.postMessage({ id, call }); }
      catch {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(new Error('AI 运行进程不可用，请重新打开 CloudHelm 并核验远端状态。'));
      }
    });
  }

  private receive(message: RuntimeMessage): void {
    if (this.closing || this.stopped) return;
    if ('filePreview' in message) {
      try { this.filePreview?.(message.filePreview); } catch { /* Private UI data is discarded, never logged. */ }
      return;
    }
    if ('diagnostic' in message) { this.diagnostic(message.diagnostic); return; }
    if ('fileJournalRequest' in message) {
      const query = message.fileJournalRequest;
      let result: { record?: import('@cloudhelm/contracts').FileTransactionViewRecord; error?: string };
      try { result = this.fileJournal?.(query.command) ?? { error: 'journal-unavailable' }; }
      catch { result = { error: 'journal-unavailable' }; }
      try { this.child.postMessage({ fileJournalResult: { id: query.id, ...result } }); } catch { /* Durable record remains authoritative. */ }
      return;
    }
    if ('runtimeResourceRequest' in message) {
      const query = message.runtimeResourceRequest; let error: string | undefined;
      try { if (!this.runtimeResource) throw new Error(); this.runtimeResource(query.record); } catch { error = 'journal-unavailable'; }
      try { this.child.postMessage({ runtimeResourceResult: { id: query.id, error } }); } catch { /* Do not replay a lost ACK. */ }
      return;
    }
    if ('budgetRequest' in message) {
      const query = message.budgetRequest;
      let result: import('@cloudhelm/contracts').BudgetOutcome;
      try { result = this.requestBudget?.(query.command) ?? { error: 'budget-unavailable' }; }
      catch { result = { error: 'budget-unavailable' }; }
      try { this.child.postMessage({ budgetResult: { id: query.id, ...result } }); }
      catch { /* A lost acknowledgment never refunds or replays a committed reservation. */ }
      return;
    }
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

  private rejectPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Agent runtime stopped; remote command outcomes require verification'));
    }
    this.pending.clear();
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.rejectPending();
    if (!this.stopped) this.child.kill();
  }
}
