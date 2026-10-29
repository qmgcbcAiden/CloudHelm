import { Type, type Static } from 'typebox';

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9.:_-]*$' });
const Hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Decimal = Type.String({ pattern: '^-?[0-9]{1,30}$' });
const Path = Type.String({ minLength: 1, maxLength: 4096, pattern: '^/[^\\u0000]*$' });
const Closed = { additionalProperties: false };
export const FileIdentitySchema = Type.Object({ device: Decimal, inode: Decimal, size: Type.Integer({ minimum: 0 }), mtimeNs: Decimal, ctimeNs: Decimal }, Closed);
export const FileMetadataSchema = Type.Object({ uid: Type.Integer({ minimum: 0 }), gid: Type.Integer({ minimum: 0 }), mode: Type.Integer({ minimum: 0, maximum: 511 }),
  xattrs: Type.Record(Type.String({ maxLength: 255 }), Hash, { maxProperties: 128 }) }, Closed);
export const FileSnapshotSchema = Type.Object({ path: Path, parent: FileIdentitySchema, exists: Type.Boolean(), identity: Type.Optional(FileIdentitySchema),
  metadata: Type.Optional(FileMetadataSchema), sha256: Type.Optional(Hash) }, Closed);
export const NativeFileArtifactSchema = Type.Object({ protocolVersion: Type.Literal(1), platform: Type.Literal('linux'),
  arch: Type.Union([Type.Literal('amd64'), Type.Literal('arm64')]), sha256: Hash, size: Type.Integer({ minimum: 1 }) }, Closed);
export const FileOperationPlanSchema = Type.Object({ version: Type.Literal(1), transactionId: Id, before: FileSnapshotSchema,
  contentSha256: Type.Optional(Hash), contentSize: Type.Integer({ minimum: 0, maximum: 1_048_576 }), metadataPolicy: Type.Literal('preserve-or-refuse'), runtime: NativeFileArtifactSchema }, Closed);
const Stage = Type.Union([Type.Literal('prepared'), Type.Literal('staged'), Type.Literal('committed'), Type.Literal('confirmed'), Type.Literal('conflict'), Type.Literal('unknown')]);
export const FileTransactionRecordSchema = Type.Object({ id: Id, operationId: Id, taskId: Id, hostId: Id, fingerprint: Hash,
  loginAs: Type.String({ minLength: 1, maxLength: 256 }), runAs: Type.String({ minLength: 1, maxLength: 256 }), plan: FileOperationPlanSchema,
  stage: Stage, revision: Type.Integer({ minimum: 1 }), directory: Type.Optional(Path), backup: Type.Optional(Path),
  receipt: Type.Optional(Type.Object({ transactionId: Id, fingerprint: Hash, targetSha256: Type.Optional(Hash), deleted: Type.Boolean() }, Closed)), updatedAt: Type.Integer({ minimum: 0 }) }, Closed);
export type FileTransactionViewRecord = Static<typeof FileTransactionRecordSchema>;
export const FileJournalCommandSchema = Type.Union([
  Type.Object({ kind: Type.Literal('get'), id: Id }, Closed),
  Type.Object({ kind: Type.Literal('commit'), record: FileTransactionRecordSchema, expectedRevision: Type.Union([Type.Null(), Type.Integer({ minimum: 1 })]) }, Closed)
]);
export type FileJournalCommand = Static<typeof FileJournalCommandSchema>;
export const FileJournalResultSchema = Type.Union([
  Type.Object({ id: Id, record: Type.Optional(FileTransactionRecordSchema) }, Closed),
  Type.Object({ id: Id, error: Type.Union([Type.Literal('journal-invalid'), Type.Literal('journal-unavailable'), Type.Literal('journal-conflict')]) }, Closed)
]);
export type FileJournalResult = Static<typeof FileJournalResultSchema>;
export type FileJournalRequest = { fileJournalRequest: { id: string; command: FileJournalCommand } };
export interface FileApprovalPreviewView { path: string; beforeSha256?: string; afterSha256?: string; before: string; after: string; encoding: 'utf8' | 'base64'; metadata: string }

export const FileRecoveryViewSchema = Type.Object({ lockState: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('confirmed')])), transactionId: Id, operationId: Id, taskId: Id, hostId: Id, target: Path,
  evidence: Type.Union([Type.Literal('receipt-confirmed'), Type.Literal('content-matches'), Type.Literal('original-observed'), Type.Literal('conflict'), Type.Literal('unavailable')]),
  observedAt: Type.Integer({ minimum: 0 }), directory: Type.Optional(Path), backup: Type.Optional(Path) }, Closed);
export type FileRecoveryView = Static<typeof FileRecoveryViewSchema>;
