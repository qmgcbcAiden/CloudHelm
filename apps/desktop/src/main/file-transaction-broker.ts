import { Value } from 'typebox/value';
import type { FileTransactionRecord } from '@cloudhelm/core';
import { FileJournalCommandSchema, type FileJournalCommand } from '@cloudhelm/contracts';

export interface FileTransactionStore {
  get<T>(bucket: string, id: string): T | undefined;
  /** Atomic compare-and-swap; an identical retry returns the previous receipt. */
  commitFileTransaction(record: FileTransactionRecord, expectedRevision: number | null): FileTransactionRecord;
}
export function createFileJournalHandler(store: FileTransactionStore, authorize: (command: Readonly<FileJournalCommand>) => void) {
  return (input: unknown): { record?: FileTransactionRecord; error?: 'journal-invalid' | 'journal-unavailable' | 'journal-conflict' } => {
    if (!Value.Check(FileJournalCommandSchema, input)) return { error: 'journal-invalid' };
    const command = structuredClone(input);
    try {
      authorize(command);
      if (command.kind === 'get') return { record: store.get<FileTransactionRecord>('file-transactions', command.id) };
      const record = command.record;
      if (record.id !== record.plan.transactionId || record.revision !== (command.expectedRevision ?? 0) + 1
        || (record.receipt && (record.receipt.transactionId !== record.id || record.receipt.fingerprint !== record.fingerprint))) return { error: 'journal-invalid' };
      const previous = store.get<FileTransactionRecord>('file-transactions', record.id);
      if (previous && (previous.operationId !== record.operationId || previous.taskId !== record.taskId || previous.hostId !== record.hostId
        || previous.fingerprint !== record.fingerprint || previous.loginAs !== record.loginAs || previous.runAs !== record.runAs
        || JSON.stringify(previous.plan) !== JSON.stringify(record.plan))) return { error: 'journal-conflict' };
      if ((!previous && command.expectedRevision !== null) || (previous && previous.revision !== command.expectedRevision
        && JSON.stringify(previous) !== JSON.stringify(record))) return { error: 'journal-conflict' };
      const next: Record<FileTransactionRecord['stage'], FileTransactionRecord['stage'][]> = {
        prepared: ['staged', 'confirmed', 'conflict', 'unknown'], staged: ['committed', 'confirmed', 'conflict', 'unknown'],
        committed: ['confirmed', 'unknown'], confirmed: ['confirmed'], conflict: ['conflict'], unknown: ['confirmed', 'unknown', 'conflict']
      };
      if (!previous && (record.stage !== 'prepared' || record.receipt)) return { error: 'journal-invalid' };
      if (previous && previous.revision !== record.revision && !next[previous.stage].includes(record.stage)) return { error: 'journal-conflict' };
      if (['confirmed', 'committed'].includes(record.stage) && (!record.receipt || record.receipt.targetSha256 !== record.plan.contentSha256
        || record.receipt.deleted !== (record.plan.contentSha256 === undefined))) return { error: 'journal-invalid' };
      return { record: store.commitFileTransaction(record, command.expectedRevision) };
    } catch { return { error: 'journal-unavailable' }; }
  };
}
