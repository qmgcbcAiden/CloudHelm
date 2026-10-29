import type { FileTransactionJournal, FileTransactionRecord } from '@cloudhelm/core';
import type { FileRemotePort, ManagedFileOperation } from './file-transactions.js';

export interface FileRecoveryObservation {
  transactionId: string; operationId: string; taskId: string; hostId: string; target: string;
  evidence: 'receipt-confirmed' | 'content-matches' | 'original-observed' | 'conflict' | 'unavailable';
  observedAt: number; directory?: string; backup?: string;
}
/** Read-only remote recovery never grants an apply/replay capability. */
export async function recoverFileTransaction(record: FileTransactionRecord, operation: ManagedFileOperation,
  remote: FileRemotePort, journal: FileTransactionJournal, signal?: AbortSignal): Promise<{ record: FileTransactionRecord; view: FileRecoveryObservation; resolved: boolean }> {
  if (operation.id !== record.operationId || operation.scope.hostId !== record.hostId || operation.scope.taskId !== record.taskId
    || operation.scope.runAs !== record.runAs || (operation.scope.loginAs ?? operation.scope.runAs) !== record.loginAs
    || JSON.stringify(operation.filePlan) !== JSON.stringify(record.plan)) throw new Error('File recovery identity binding changed');
  const current = await journal.get(record.id, signal);
  if (!current || JSON.stringify(current) !== JSON.stringify(record)) throw new Error('File recovery journal changed; reload it');
  const view: FileRecoveryObservation = { transactionId: record.id, operationId: record.operationId, taskId: record.taskId,
    hostId: record.hostId, target: record.plan.before.path, evidence: 'unavailable', observedAt: Date.now(), directory: record.directory, backup: record.backup };
  let result: Awaited<ReturnType<FileRemotePort['recover']>>;
  try { result = await remote.recover(operation, record.fingerprint, signal); }
  catch { return { record, view, resolved: false }; }
  signal?.throwIfAborted();
  view.directory = result.directory ?? view.directory; view.backup = result.backup ?? view.backup;
  const receipt = result.receipt; const snapshot = result.snapshot;
  const matches = !!snapshot && snapshot.path === record.plan.before.path
    && snapshot.parent.device === record.plan.before.parent.device && snapshot.parent.inode === record.plan.before.parent.inode
    && (record.plan.contentSha256 === undefined ? !snapshot.exists : snapshot.exists && snapshot.sha256 === record.plan.contentSha256);
  if (result.status === 'succeeded' && result.stage === 'confirmed' && matches && receipt
    && receipt.transactionId === record.id && receipt.fingerprint === record.fingerprint
    && receipt.targetSha256 === record.plan.contentSha256 && receipt.deleted === (record.plan.contentSha256 === undefined)) {
    const confirmed = record.stage === 'confirmed' && JSON.stringify(record.receipt) === JSON.stringify(receipt) ? record
      : await journal.commit({ ...record, stage: 'confirmed', receipt, directory: view.directory, backup: view.backup,
        revision: record.revision + 1, updatedAt: Date.now() }, record.revision, signal);
    view.evidence = 'receipt-confirmed';
    return { record: confirmed, view, resolved: true };
  }
  view.evidence = matches ? 'content-matches' : result.code === 'original-observed' ? 'original-observed' : result.code === 'conflict' ? 'conflict' : 'unavailable';
  return { record, view, resolved: false };
}
