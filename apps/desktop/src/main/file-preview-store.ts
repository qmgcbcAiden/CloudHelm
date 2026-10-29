import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { FilePreviewEnvelopeSchema, type FilePreviewEnvelope, type FilePreviewResponse } from '@cloudhelm/contracts';

const TTL = 15 * 60_000;
const MAX_ENTRIES = 16;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_BODY = 1024 * 1024;
interface Entry { value: FilePreviewEnvelope; expiresAt: number; size: number; timer: ReturnType<typeof setTimeout> }

function validBody(body: string, encoding: 'utf8' | 'base64', digest?: string): boolean {
  if (!digest) return body === '';
  const data = Buffer.from(body, encoding);
  return data.length <= MAX_BODY && data.toString(encoding) === body
    && createHash('sha256').update(data).digest('hex') === digest;
}

/** Deliberately has no storage/log/event dependency; bodies expire and are not restorable. */
export class FilePreviewStore {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  constructor(private readonly authorized: (value: FilePreviewEnvelope) => boolean, private readonly now: () => number = Date.now) {}

  put(raw: unknown): boolean {
    if (!Value.Check(FilePreviewEnvelopeSchema, raw) || !this.authorized(raw)) return false;
    const preview = raw.preview;
    if (!validBody(preview.before, preview.encoding, preview.beforeSha256) || !validBody(preview.after, preview.encoding, preview.afterSha256)) return false;
    this.prune();
    const previous = this.entries.get(raw.operationId);
    // Duplicated delivery does not refresh retention or replace an approved body.
    if (previous?.value.transactionId === raw.transactionId) return true;
    const size = JSON.stringify(raw).length * 2 + 1024;
    if (size > MAX_BYTES) return false;
    this.drop(raw.operationId);
    while (this.entries.size >= MAX_ENTRIES || this.bytes + size > MAX_BYTES) this.drop(this.entries.keys().next().value!);
    const expiresAt = this.now() + TTL;
    const operationId = raw.operationId;
    const timer = setTimeout(() => this.drop(operationId), TTL); timer.unref();
    this.entries.set(raw.operationId, { value: structuredClone(raw), expiresAt, size, timer }); this.bytes += size;
    return true;
  }

  read(operationId: string): FilePreviewResponse {
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.:_-]{0,127}$/u.test(operationId)) throw new Error('无效文件操作');
    this.prune();
    const entry = this.entries.get(operationId);
    if (entry && this.authorized(entry.value)) return { status: 'available', operationId, expiresAt: entry.expiresAt, preview: structuredClone(entry.value.preview) };
    this.drop(operationId);
    return { status: 'unavailable', operationId, reason: 'expired-or-unavailable' };
  }
  clear(): void { for (const id of this.entries.keys()) this.drop(id); }
  private prune(): void { for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.drop(id); }
  private drop(id: string): void {
    const entry = this.entries.get(id); if (!entry) return;
    clearTimeout(entry.timer); this.bytes -= entry.size; this.entries.delete(id);
  }
}
