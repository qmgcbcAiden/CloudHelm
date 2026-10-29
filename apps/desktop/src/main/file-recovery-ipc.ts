import { ipcMain } from 'electron';
import type { SqliteStore } from '@cloudhelm/adapters';
import type { FileTransactionRecord } from '@cloudhelm/core';
import { operationOutcomeResolvable, type FileRecoveryView, type OperationView } from '@cloudhelm/contracts';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';

export function registerFileRecoveryIpc(state: AppState, runtime: RuntimeBridge, store: SqliteStore,
  connectHost: (hostId: string) => Promise<void>): void {
  const recovering = new Set<string>();
  async function synchronize(operation: OperationView): Promise<FileRecoveryView> {
    if (!operation.fileRecovery || operation.fileRecovery.evidence !== 'receipt-confirmed' || !operation.reconciledAt) throw new Error('没有已确认的恢复结果');
    const receipt = operation.fileTransactionId && store.get<FileTransactionRecord>('file-transactions', operation.fileTransactionId);
    if (!receipt || receipt.stage !== 'confirmed' || receipt.operationId !== operation.id || receipt.taskId !== operation.taskId
      || receipt.hostId !== operation.hostId || !receipt.receipt) throw new Error('缺少持久化提交凭据');
    await runtime.call({ method: 'commit-file-recovery', operation });
    const view: FileRecoveryView = { ...operation.fileRecovery, lockState: 'confirmed' };
    state.record({ type: 'operation', value: { ...operation, fileRecovery: view } });
    return view;
  }
  ipcMain.handle('cloudhelm:recover-file-transaction', async (_event, transactionId: string): Promise<FileRecoveryView> => {
    if (typeof transactionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/u.test(transactionId)) throw new Error('无效文件事务');
    if (recovering.has(transactionId)) throw new Error('该文件事务正在核验');
    const record = store.get<FileTransactionRecord>('file-transactions', transactionId);
    const operation = record && state.snapshot().operations.find((item) => item.id === record.operationId);
    if (!record || !operation || operation.fileTransactionId !== record.id || operation.hostId !== record.hostId
      || operation.taskId !== record.taskId || (!operationOutcomeResolvable(operation) && operation.fileRecovery?.lockState !== 'pending')) throw new Error('未找到待核验的文件事务');
    recovering.add(transactionId);
    try {
      if (operation.fileRecovery?.lockState === 'pending') return await synchronize(operation);
      if (state.getHost(record.hostId).status !== 'connected') await connectHost(record.hostId);
      await runtime.call({ method: 'prepare-operation-risk', operationId: record.operationId, hostId: record.hostId });
      const result = await runtime.call<{ view: FileRecoveryView; resolved: boolean }>({ method: 'recover-file-transaction', record });
      const view = result.view;
      if (!view || view.transactionId !== record.id || view.operationId !== operation.id || view.taskId !== record.taskId
        || view.hostId !== record.hostId || view.target !== record.plan.before.path
        || !Number.isSafeInteger(view.observedAt) || !['receipt-confirmed', 'content-matches', 'original-observed', 'conflict', 'unavailable'].includes(view.evidence)) {
        throw new Error('文件核验返回的绑定无效');
      }
      const current = state.snapshot().operations.find((item) => item.id === operation.id);
      if (!current || current.reconciledAt) throw new Error('原操作结果已更新，请刷新');
      let updated: OperationView = { ...current, fileRecovery: view };
      if (result.resolved) {
        const confirmed = store.get<FileTransactionRecord>('file-transactions', record.id);
        if (view.evidence !== 'receipt-confirmed' || confirmed?.stage !== 'confirmed'
          || confirmed.receipt?.fingerprint !== record.fingerprint || confirmed.receipt?.transactionId !== record.id) throw new Error('没有已持久化的原提交凭据');
        updated = { ...updated, fileRecovery: { ...view, lockState: 'pending' }, reconciledAt: view.observedAt,
          reconciliation: { kind: 'evidence', at: view.observedAt, outcome: 'succeeded', evidenceOperationIds: [],
            explanation: '原生事务提交凭据与原操作指纹匹配，且当前文件版本已读回复核。详见文件恢复凭据。' } };
      }
      // AppState commits before publishing; storage failure must leave the host write lock held.
      state.record({ type: 'operation', value: updated });
      return result.resolved ? await synchronize(updated) : view;
    } finally { recovering.delete(transactionId); }
  });
}
