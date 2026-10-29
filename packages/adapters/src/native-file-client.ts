import path from 'node:path';
import type { ClientChannel } from 'ssh2';
import { MANAGED_FILE_LIMIT, type FileSnapshot, type FileTransactionStage, type NativeArtifact, type NativeBinding, type ProposedOperation } from '@cloudhelm/core';

type Operation = Extract<ProposedOperation, { kind: 'write-file' | 'upload' | 'delete-path' }>;
export interface NativeFileResult {
  status: 'succeeded' | 'failed' | 'unknown' | 'cleaned'; effects: 'none' | 'possible'; code?: string; stage?: FileTransactionStage;
  snapshot?: FileSnapshot; directory?: string; backup?: string;
  receipt?: { transactionId: string; fingerprint: string; targetSha256?: string; deleted: boolean };
}
export type NativeFileOpen = (operation: Operation, signal?: AbortSignal, assertAuthorized?: () => void)
  => Promise<{ channel: ClientChannel; binding: NativeBinding; assertCurrent?: () => void }>;
function locations(value: NativeFileResult, operation: Operation): boolean {
  const plan = operation.filePlan; if (!plan || !value.directory) return value.directory === undefined && value.backup === undefined;
  const directory = path.posix.join(path.posix.dirname(plan.before.path), `.cloudhelm-txn-${plan.transactionId}`);
  return value.directory === directory && value.backup === (plan.before.exists ? path.posix.join(directory, 'backup') : undefined);
}
const frameLimit = 2 * 1024 * 1024;
const digest = /^[a-f0-9]{64}$/u;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function identity(value: unknown): boolean {
  return object(value) && ['device', 'inode', 'mtimeNs', 'ctimeNs'].every((key) => typeof value[key] === 'string' && /^-?\d{1,30}$/u.test(value[key] as string))
    && Number.isSafeInteger(value.size) && (value.size as number) >= 0;
}
function snapshot(value: unknown): value is FileSnapshot {
  if (!object(value) || typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 4096 || !identity(value.parent) || typeof value.exists !== 'boolean') return false;
  if (!value.exists) return value.identity === undefined && value.metadata === undefined && value.sha256 === undefined;
  if (!identity(value.identity) || !object(value.identity) || (value.identity.size as number) > MANAGED_FILE_LIMIT || typeof value.sha256 !== 'string' || !digest.test(value.sha256)
    || !object(value.metadata) || !Number.isSafeInteger(value.metadata.uid) || !Number.isSafeInteger(value.metadata.gid)
    || !Number.isInteger(value.metadata.mode) || (value.metadata.mode as number) < 0 || (value.metadata.mode as number) > 511 || !object(value.metadata.xattrs)) return false;
  return Object.entries(value.metadata.xattrs).length <= 128 && Object.entries(value.metadata.xattrs).every(([key, data]) => key.length <= 255 && typeof data === 'string' && digest.test(data));
}
function result(value: unknown): value is NativeFileResult {
  return object(value) && ['succeeded', 'failed', 'unknown', 'cleaned'].includes(String(value.status)) && ['none', 'possible'].includes(String(value.effects))
    && (value.code === undefined || typeof value.code === 'string' && /^[a-z-]{1,80}$/u.test(value.code))
    && (value.stage === undefined || ['prepared', 'staged', 'committed', 'confirmed', 'conflict', 'unknown'].includes(String(value.stage)))
    && (value.snapshot === undefined || snapshot(value.snapshot))
    && ['directory', 'backup'].every((key) => value[key] === undefined || typeof value[key] === 'string' && (value[key] as string).startsWith('/') && (value[key] as string).length <= 4096)
    && (value.receipt === undefined || object(value.receipt) && typeof value.receipt.transactionId === 'string' && typeof value.receipt.fingerprint === 'string'
      && digest.test(value.receipt.fingerprint) && typeof value.receipt.deleted === 'boolean'
      && (value.receipt.targetSha256 === undefined || typeof value.receipt.targetSha256 === 'string' && digest.test(value.receipt.targetSha256)));
}
/** No channel bytes enter logs/model context. The opener owns deployment authorization. */
export class NativeFileClient {
  constructor(readonly artifact: NativeArtifact, private readonly open: NativeFileOpen, private readonly timeoutMs = 30_000) {}
  async inspect(operation: Operation, path: string, signal?: AbortSignal): Promise<{ snapshot: FileSnapshot; content: Uint8Array }> {
    const response = await this.request(operation, 'inspect', { path }, signal);
    if (!object(response) || response.status !== 'inspected' || !snapshot(response.snapshot)
      || response.snapshot.path !== path || (response.contentBase64 !== undefined && (typeof response.contentBase64 !== 'string' || response.contentBase64.length > 1_398_104))) throw new Error('Native file inspection failed');
    const encoded = (response.contentBase64 ?? '') as string;
    const content = Buffer.from(encoded, 'base64');
    if (content.length > MANAGED_FILE_LIMIT || content.toString('base64') !== encoded) throw new Error('Native file content is invalid');
    return { snapshot: response.snapshot, content };
  }
  apply(operation: Operation, fingerprint: string, content: Uint8Array | undefined, signal?: AbortSignal,
    assertAuthorized?: () => void, onStaged?: (result: NativeFileResult) => Promise<void>): Promise<NativeFileResult> {
    return this.transaction(operation, 'apply', fingerprint, content, signal, assertAuthorized, onStaged);
  }
  recover(operation: Operation, fingerprint: string, signal?: AbortSignal): Promise<NativeFileResult> { return this.transaction(operation, 'recover', fingerprint, undefined, signal); }
  cleanup(operation: Operation, fingerprint: string, signal?: AbortSignal, assertAuthorized?: () => void): Promise<NativeFileResult> { return this.transaction(operation, 'cleanup', fingerprint, undefined, signal, assertAuthorized); }
  private async transaction(operation: Operation, type: string, fingerprint: string, content: Uint8Array | undefined, signal?: AbortSignal,
    assertAuthorized?: () => void, onStaged?: (result: NativeFileResult) => Promise<void>): Promise<NativeFileResult> {
    const plan = operation.filePlan;
    if (!plan || !digest.test(fingerprint) || plan.runtime.protocolVersion !== this.artifact.protocolVersion
      || (type === 'apply' && JSON.stringify(plan.runtime) !== JSON.stringify(this.artifact))) throw new Error('Native file plan is unavailable or stale');
    const response = await this.request(operation, type, { plan, fingerprint, action: operation.kind === 'delete-path' ? 'delete' : 'write',
      ...(type === 'apply' ? { contentBase64: content ? Buffer.from(content).toString('base64') : '' } : {}) }, signal, assertAuthorized, onStaged);
    if (!result(response) || !locations(response, operation)) throw new Error('Invalid native file result');
    if (response.receipt && (response.receipt.transactionId !== plan.transactionId || response.receipt.fingerprint !== fingerprint
      || response.receipt.deleted !== (operation.kind === 'delete-path') || response.receipt.targetSha256 !== plan.contentSha256)) throw new Error('Native file receipt binding mismatch');
    if (response.status === 'succeeded' && (response.stage !== 'confirmed' || !response.receipt || !response.snapshot
      || response.snapshot.path !== plan.before.path || (operation.kind === 'delete-path' ? response.snapshot.exists : response.snapshot.sha256 !== plan.contentSha256))) throw new Error('Native file completion is not verified');
    return response;
  }
  private async request(operation: Operation, type: string, payload: unknown, signal?: AbortSignal, assertAuthorized?: () => void,
    onStaged?: (result: NativeFileResult) => Promise<void>): Promise<unknown> {
    signal?.throwIfAborted(); assertAuthorized?.();
    const { channel, binding, assertCurrent } = await this.open(operation, signal, assertAuthorized);
    const current = () => { signal?.throwIfAborted(); assertAuthorized?.(); assertCurrent?.(); };
    if (binding.version !== 1 || binding.operationId !== operation.id || !binding.sessionId || !Number.isInteger(binding.generation) || binding.generation < 1) { channel.destroy(); throw new Error('Invalid native file channel binding'); }
    return new Promise((resolve, reject) => {
      let settled = false; let buffered = Buffer.alloc(0); let staged = false; let commitSent = false; let stderrBytes = 0;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        channel.destroy(); if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new Error('Native file operation canceled; verify before retry'));
      const timer = setTimeout(() => finish(new Error('Native file operation timed out; verify before retry')), this.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      channel.on('error', () => finish(new Error('Native file channel failed')));
      channel.on('close', () => { if (!settled) finish(new Error('Native file channel closed without a receipt')); });
      channel.stderr?.on('data', (data: Buffer) => { stderrBytes += data.length; if (stderrBytes > 65536) finish(new Error('Native file stderr limit exceeded')); });
      channel.on('data', (data: Buffer) => {
        if (settled) return;
        buffered = Buffer.concat([buffered, data]); if (buffered.length > frameLimit) { finish(new Error('Native file frame limit exceeded')); return; }
        let newline: number;
        while ((newline = buffered.indexOf(10)) >= 0 && !settled) {
          const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
          let frame: unknown; try { frame = JSON.parse(line.toString('utf8')); } catch { finish(new Error('Invalid native file frame')); return; }
          if (!object(frame) || frame.version !== binding.version || frame.sessionId !== binding.sessionId || frame.operationId !== binding.operationId || frame.generation !== binding.generation) {
            finish(new Error('Native file frame binding mismatch')); return;
          }
          if (frame.type === 'file-result') {
            if (type === 'apply' && object(frame.result) && frame.result.status === 'succeeded' && !commitSent) { finish(new Error('Native commit was not authorized')); return; }
            try { current(); } catch { finish(new Error('Native file authorization expired')); return; }
            finish(undefined, frame.result); return;
          }
          if (frame.type !== 'file-staged' || type !== 'apply' || staged || !result(frame.result) || frame.result.stage !== 'staged' || !locations(frame.result, operation)) { finish(new Error('Unexpected native file response')); return; }
          staged = true;
          void (async () => {
            try {
              current();
              if (!onStaged) throw new Error('Durable staging acknowledgment is required');
              await onStaged(frame.result as NativeFileResult);
              if (settled) return;
              current();
              commitSent = true;
              channel.write(JSON.stringify({ ...binding, type: 'file-commit' }) + '\n');
            } catch { finish(new Error('File commit authorization or journal acknowledgment failed')); }
          })();
        }
      });
      try {
        current();
        const frame = JSON.stringify({ ...binding, type, payload }) + '\n';
        if (Buffer.byteLength(frame) >= frameLimit) throw new Error('Native file request limit exceeded');
        channel.write(frame);
      } catch { finish(new Error('Native file request not dispatched')); }
    });
  }
}
