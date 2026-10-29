import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  fileReadProtectionReason, MANAGED_FILE_LIMIT, type FileApprovalPreview, type FileSnapshot,
  type FileTransactionStage, type NativeArtifact, type ProposedOperation
} from '@cloudhelm/core';

export type ManagedFileOperation = Extract<ProposedOperation, { kind: 'write-file' | 'upload' | 'delete-path' }>;
export interface RemoteFileResult {
  status: 'succeeded' | 'failed' | 'unknown' | 'cleaned';
  effects: 'none' | 'possible';
  code?: string;
  stage?: FileTransactionStage;
  snapshot?: FileSnapshot;
  directory?: string;
  backup?: string;
  receipt?: { transactionId: string; fingerprint: string; targetSha256?: string; deleted: boolean };
}
/** Adapter implementations operate only over a previously authorized native runtime. */
export interface FileRemotePort {
  readonly artifact: NativeArtifact;
  inspect(operation: ManagedFileOperation, path: string, signal?: AbortSignal): Promise<{ snapshot: FileSnapshot; content: Uint8Array }>;
  apply(operation: ManagedFileOperation, fingerprint: string, content: Uint8Array | undefined,
    signal?: AbortSignal, assertAuthorized?: () => void, onStaged?: (result: RemoteFileResult) => Promise<void>): Promise<RemoteFileResult>;
  recover(operation: ManagedFileOperation, fingerprint: string, signal?: AbortSignal): Promise<RemoteFileResult>;
  cleanup(operation: ManagedFileOperation, fingerprint: string, signal?: AbortSignal, assertAuthorized?: () => void): Promise<RemoteFileResult>;
}
export type ReadUpload = (operation: Extract<ManagedFileOperation, { kind: 'upload' }>, signal?: AbortSignal) => Promise<Uint8Array>;
export function fileContentHash(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }
export async function loadFileOperationContent(operation: ManagedFileOperation, readUpload: ReadUpload, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  signal?.throwIfAborted();
  const content = operation.kind === 'delete-path' ? undefined : operation.kind === 'write-file'
    ? Buffer.from(operation.content, 'utf8') : await readUpload(operation, signal);
  signal?.throwIfAborted();
  if (content && content.length > MANAGED_FILE_LIMIT) throw new Error('Managed files are limited to 1 MiB');
  if (operation.kind === 'upload' && (!content || content.length !== operation.size || fileContentHash(content) !== operation.contentSha256)) {
    throw new Error('Selected upload changed; propose the file again');
  }
  return content;
}
function renderPreview(before: Uint8Array, after: Uint8Array): Pick<FileApprovalPreview, 'before' | 'after' | 'encoding'> {
  const old = Buffer.from(before); const next = Buffer.from(after);
  const text = (data: Buffer) => !data.includes(0) && Buffer.from(data.toString('utf8'), 'utf8').equals(data);
  if (text(old) && text(next)) return { before: old.toString('utf8'), after: next.toString('utf8'), encoding: 'utf8' };
  // Binary bodies remain a human-only preview; they never enter operation journals.
  return { before: old.toString('base64'), after: next.toString('base64'), encoding: 'base64' };
}
/** Preparation returns private UI data separately from the fingerprinted plan. */
export async function prepareFileOperation(operation: ManagedFileOperation, remote: FileRemotePort, readUpload: ReadUpload,
  signal?: AbortSignal): Promise<{ operation: ManagedFileOperation; preview: FileApprovalPreview }> {
  const content = await loadFileOperationContent(operation, readUpload, signal);
  const target = path.posix.resolve(operation.scope.cwd, operation.kind === 'upload' ? operation.remotePath : operation.path);
  const readDenial = fileReadProtectionReason(target, operation.scope);
  if (readDenial) throw new Error(readDenial);
  const inspected = await remote.inspect(operation, target, signal);
  signal?.throwIfAborted();
  if (inspected.snapshot.path !== target || inspected.content.length > MANAGED_FILE_LIMIT
    || (inspected.snapshot.exists && fileContentHash(inspected.content) !== inspected.snapshot.sha256)
    || (!inspected.snapshot.exists && inspected.content.length !== 0)) throw new Error('Remote file snapshot is invalid');
  if (operation.kind === 'delete-path' && !inspected.snapshot.exists) throw new Error('Only an existing regular file can be deleted');
  const afterSha256 = content ? fileContentHash(content) : undefined;
  const filePlan = { version: 1 as const, transactionId: randomUUID(), before: structuredClone(inspected.snapshot),
    contentSha256: afterSha256, contentSize: content?.length ?? 0, metadataPolicy: 'preserve-or-refuse' as const,
    runtime: structuredClone(remote.artifact) };
  const metadata = inspected.snapshot.metadata;
  const preview: FileApprovalPreview = { path: target, beforeSha256: inspected.snapshot.sha256, afterSha256,
    ...renderPreview(inspected.content, content ?? new Uint8Array()),
    metadata: metadata ? `保留 uid=${metadata.uid}、gid=${metadata.gid}、mode=${metadata.mode.toString(8).padStart(3, '0')} 及已验证扩展属性；无法保留则拒绝。`
      : '新文件使用当前执行身份，权限 0600。' };
  return { operation: { ...operation, filePlan }, preview };
}
