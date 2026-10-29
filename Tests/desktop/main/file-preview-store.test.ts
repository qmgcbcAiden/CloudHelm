import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { FilePreviewEnvelope, OperationView } from '@cloudhelm/contracts';
import { FilePreviewStore } from '../../../apps/desktop/src/main/file-preview-store.js';
import { createFilePreviewStore, registerApprovalIpc, registerFilePreviewIpc } from '../../../apps/desktop/src/main/file-preview-ipc.js';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } }));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function envelope(id = 'operation', body = 'private old'): FilePreviewEnvelope {
  return { operationId: id, taskId: 'task', hostId: 'host', transactionId: `txn-${id}`, preview: {
    path: '/srv/config', before: body, after: 'new', beforeSha256: digest(body), afterSha256: digest('new'), encoding: 'utf8', metadata: 'preserve' } };
}
const stores: FilePreviewStore[] = [];
function store(authorized: (value: FilePreviewEnvelope) => boolean = () => true) {
  const result = new FilePreviewStore(authorized); stores.push(result); return result;
}
afterEach(() => { stores.forEach((item) => item.clear()); stores.length = 0; handlers.clear(); vi.useRealTimers(); });

it('keeps exact complete content only in a private clone and never extends the original 15-minute expiry', () => {
  vi.useFakeTimers(); const f = store(); const value = envelope(); const original = structuredClone(value);
  expect(f.put(value)).toBe(true); value.preview.before = 'changed';
  expect(f.read('operation')).toMatchObject({ status: 'available', preview: { before: 'private old', after: 'new' } });
  vi.advanceTimersByTime(14 * 60_000); expect(f.put(original)).toBe(true);
  vi.advanceTimersByTime(60_000); expect(f.read('operation')).toEqual({ status: 'unavailable', operationId: 'operation', reason: 'expired-or-unavailable' });
});

it('refuses unbound, malformed, oversized, lossy or hash-mismatched bodies', () => {
  const f = store((value) => value.taskId === 'task');
  expect(f.put({ ...envelope(), taskId: 'other' })).toBe(false);
  expect(f.put({ ...envelope(), extra: 'unexpected' })).toBe(false);
  const mismatch = envelope(); mismatch.preview.beforeSha256 = digest('different'); expect(f.put(mismatch)).toBe(false);
  const oversized = envelope('large', 'x'.repeat(1024 * 1024 + 1)); expect(f.put(oversized)).toBe(false);
  const invalidBase64 = envelope(); invalidBase64.preview.encoding = 'base64'; expect(f.put(invalidBase64)).toBe(false);
  const missingHash = envelope(); delete missingHash.preview.beforeSha256; expect(f.put(missingHash)).toBe(false);
  const binary = envelope(); binary.preview.encoding = 'base64'; binary.preview.before = Buffer.from('private old').toString('base64');
  binary.preview.after = Buffer.from('new').toString('base64'); expect(f.put(binary)).toBe(true);
});

it('evicts by both operation count and 32 MiB of estimated retained string memory', () => {
  const small = store();
  for (let i = 0; i < 17; i++) expect(small.put(envelope(`op-${i}`))).toBe(true);
  expect(small.read('op-0').status).toBe('unavailable'); expect(small.read('op-16').status).toBe('available');
  const large = store(); const body = 'a'.repeat(1024 * 1024);
  for (let i = 0; i < 9; i++) {
    const value = envelope(`big-${i}`, body); value.preview.after = body; value.preview.afterSha256 = digest(body);
    expect(large.put(value)).toBe(true);
  }
  expect(large.read('big-0').status).toBe('unavailable'); expect(large.read('big-8').status).toBe('available');
});

it('Main validates task, host, operation and transaction on publication and every IPC read', () => {
  const operation = { id: 'operation', taskId: 'task', hostId: 'host', fileTransactionId: 'txn-operation', kind: 'write-file' } as OperationView;
  const snapshot = { conversations: [{ id: 'task', hostIds: ['host'] }], operations: [operation] };
  const f = createFilePreviewStore({ snapshot: () => snapshot } as never); stores.push(f); registerFilePreviewIpc(f);
  expect(f.put(envelope())).toBe(true);
  expect(f.put({ ...envelope(), hostId: 'other' })).toBe(false);
  expect(f.put({ ...envelope(), transactionId: 'other' })).toBe(false);
  const invoke = (id: string) => handlers.get('cloudhelm:read-file-preview')!({}, id);
  expect(invoke('operation')).toMatchObject({ status: 'available' });
  operation.fileTransactionId = 'another-transaction'; expect(invoke('operation')).toMatchObject({ status: 'unavailable' });
  expect(() => invoke('../operation')).toThrow('无效');
});

it('Main never approves a file operation without its live complete preview, while rejection remains available', async () => {
  vi.useFakeTimers(); const f = store(); f.put(envelope());
  const approval = { id: 'approval', operationId: 'operation', filePreviewOperationId: 'operation', expiresAt: Date.now() + 20 * 60_000 };
  const runtime = { call: vi.fn(async () => {}) };
  registerApprovalIpc({ snapshot: () => ({ approvals: [approval] }) } as never, runtime as never, f);
  const invoke = (approved: boolean) => handlers.get('cloudhelm:decide-approval')!({}, 'approval', approved);
  await invoke(true); expect(runtime.call).toHaveBeenLastCalledWith({ method: 'decide-approval', approvalId: 'approval', approved: true });
  runtime.call.mockClear(); vi.advanceTimersByTime(15 * 60_000);
  await expect(invoke(true)).rejects.toThrow('完整文件预览'); expect(runtime.call).not.toHaveBeenCalled();
  await invoke(false); expect(runtime.call).toHaveBeenLastCalledWith({ method: 'decide-approval', approvalId: 'approval', approved: false });
});
