import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import type { FileTransactionJournal, FileTransactionRecord } from '@cloudhelm/core';
import { FileJournalCommandSchema, FileJournalResultSchema, type FileJournalCommand, type FileJournalRequest } from '@cloudhelm/contracts';

interface Pending { command: FileJournalCommand; resolve(value: FileTransactionRecord | undefined): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; detach(): void }
/** Only Main's durable acknowledgment grants progression to remote staging/commit. */
export class FileTransactionClient implements FileTransactionJournal {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly post: (message: FileJournalRequest) => void, private readonly timeoutMs = 30_000) {}
  async commit(record: FileTransactionRecord, expectedRevision: number | null, signal?: AbortSignal): Promise<FileTransactionRecord> {
    const result = await this.request({ kind: 'commit', record, expectedRevision }, signal);
    if (!result) throw new Error('File journal commit was not acknowledged');
    return result;
  }
  get(id: string, signal?: AbortSignal): Promise<FileTransactionRecord | undefined> { return this.request({ kind: 'get', id }, signal); }
  private request(command: FileJournalCommand, signal?: AbortSignal): Promise<FileTransactionRecord | undefined> {
    if (!Value.Check(FileJournalCommandSchema, command) || this.closed) return Promise.reject(new Error('File journal unavailable'));
    signal?.throwIfAborted();
    const id = randomUUID(); const snapshot = structuredClone(command);
    return new Promise((resolve, reject) => {
      const stop = () => this.reject(id, new Error('File journal wait canceled'));
      const timer = setTimeout(() => this.reject(id, new Error('File journal acknowledgment timed out')), this.timeoutMs);
      this.pending.set(id, { command: snapshot, resolve, reject, timer, detach: () => signal?.removeEventListener('abort', stop) });
      signal?.addEventListener('abort', stop, { once: true });
      try { this.post({ fileJournalRequest: { id, command: snapshot } }); } catch { this.reject(id, new Error('File journal unavailable')); }
    });
  }
  resolve(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string') return;
    const pending = this.pending.get(raw.id); if (!pending) return;
    if (!Value.Check(FileJournalResultSchema, raw)) { this.reject(raw.id, new Error('Invalid file journal acknowledgment')); return; }
    if ('error' in raw) { this.reject(raw.id, new Error(raw.error)); return; }
    const record = raw.record; const command = pending.command;
    if (record && (record.id !== (command.kind === 'get' ? command.id : command.record.id)
      || (command.kind === 'commit' && JSON.stringify(record) !== JSON.stringify(command.record)))) {
      this.reject(raw.id, new Error('File journal acknowledgment binding changed')); return;
    }
    const waiter = this.take(raw.id); waiter?.resolve(record ? structuredClone(record) : undefined);
  }
  close(): void { this.closed = true; for (const id of this.pending.keys()) this.reject(id, new Error('File journal closed')); }
  private take(id: string): Pending | undefined { const pending = this.pending.get(id); if (pending) { this.pending.delete(id); clearTimeout(pending.timer); pending.detach(); } return pending; }
  private reject(id: string, error: Error): void { this.take(id)?.reject(error); }
}
