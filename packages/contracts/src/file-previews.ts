import { Type, type Static } from 'typebox';
import type { FileApprovalPreviewView } from './file-transactions.js';

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9.:_-]*$' });
const Hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Closed = { additionalProperties: false };
/** Private UI payload: never embed in OperationView, AppEvent or durable journals. */
export const FilePreviewEnvelopeSchema = Type.Object({ operationId: Id, taskId: Id, hostId: Id, transactionId: Id,
  preview: Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096, pattern: '^/[^\\u0000]*$' }),
    beforeSha256: Type.Optional(Hash), afterSha256: Type.Optional(Hash),
    before: Type.String({ maxLength: 1_398_104 }), after: Type.String({ maxLength: 1_398_104 }),
    encoding: Type.Union([Type.Literal('utf8'), Type.Literal('base64')]), metadata: Type.String({ maxLength: 4096 }) }, Closed) }, Closed);
export type FilePreviewEnvelope = Static<typeof FilePreviewEnvelopeSchema>;
export type FilePreviewMessage = { filePreview: FilePreviewEnvelope };
export type FilePreviewResponse = { status: 'available'; operationId: string; expiresAt: number; preview: FileApprovalPreviewView }
  | { status: 'unavailable'; operationId: string; reason: 'expired-or-unavailable' };
