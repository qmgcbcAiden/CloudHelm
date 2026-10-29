import { ipcMain } from 'electron';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';
import { FilePreviewStore } from './file-preview-store.js';

/** Both publication and reading require the authoritative operation binding. */
export function createFilePreviewStore(state: AppState, now: () => number = Date.now): FilePreviewStore {
  return new FilePreviewStore((value) => {
    const snapshot = state.snapshot();
    const task = snapshot.conversations.find((item) => item.id === value.taskId);
    const operation = snapshot.operations.find((item) => item.id === value.operationId);
    return !!task && task.hostIds.includes(value.hostId) && !!operation
      && operation.taskId === value.taskId && operation.hostId === value.hostId && operation.fileTransactionId === value.transactionId
      && ['write-file', 'upload', 'delete-path'].includes(operation.kind);
  }, now);
}
export function registerFilePreviewIpc(previews: FilePreviewStore): void {
  ipcMain.handle('cloudhelm:read-file-preview', (_event, operationId: string) => previews.read(operationId));
}
export function registerApprovalIpc(state: AppState, runtime: RuntimeBridge, previews: FilePreviewStore): void {
  ipcMain.handle('cloudhelm:decide-approval', async (_event, approvalId: string, approved: boolean) => {
    if (typeof approvalId !== 'string' || typeof approved !== 'boolean') throw new Error('无效审批回答');
    const approval = state.snapshot().approvals.find((item) => item.id === approvalId);
    if (!approval || approval.expiresAt <= Date.now()) throw new Error('审批已过期');
    if (approved && approval.filePreviewOperationId && (approval.filePreviewOperationId !== approval.operationId
      || previews.read(approval.filePreviewOperationId).status !== 'available')) throw new Error('完整文件预览已过期或不可用，请拒绝本次操作后重新核验');
    return runtime.call({ method: 'decide-approval', approvalId, approved });
  });
}
