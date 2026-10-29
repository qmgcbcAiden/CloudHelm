/** Versioned backend-owned plans. Model tool arguments cannot mint runtime grants. */
export const NATIVE_PROTOCOL_VERSION = 1 as const;
export const MANAGED_FILE_LIMIT = 1_048_576;

export interface NativeArtifact {
  protocolVersion: 1;
  platform: 'linux';
  arch: 'amd64' | 'arm64';
  sha256: string;
  size: number;
}

export interface RuntimeOperationPlan {
  version: 1;
  action: 'install' | 'launch' | 'su-bootstrap' | 'cleanup';
  directory: string;
  executable: string;
  artifact: NativeArtifact;
  sessionId: string;
  purpose: 'execute' | 'recover';
  parentOperationId?: string;
}

export interface NativeBinding {
  version: 1;
  sessionId: string;
  operationId: string;
  generation: number;
}

export interface CommandExecutionPlan {
  version: 1;
  shell: 'bash';
  steps: Array<{
    condition: 'always' | 'success' | 'failure';
    argv: string[];
    runAs: string;
    authentication: 'none' | 'sudo';
  }>;
}

/** Decimal strings retain inode and nanosecond precision across JSON/JavaScript. */
export interface FileIdentity {
  device: string;
  inode: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}

export interface FileMetadata {
  uid: number;
  gid: number;
  mode: number;
  xattrs: Record<string, string>;
}

export interface FileSnapshot {
  path: string;
  parent: FileIdentity;
  exists: boolean;
  identity?: FileIdentity;
  metadata?: FileMetadata;
  sha256?: string;
}

export interface FileOperationPlan {
  version: 1;
  transactionId: string;
  before: FileSnapshot;
  contentSha256?: string;
  contentSize: number;
  metadataPolicy: 'preserve-or-refuse';
  runtime: NativeArtifact;
}

export type FileTransactionStage = 'prepared' | 'staged' | 'committed' | 'confirmed' | 'conflict' | 'unknown';
export interface FileTransactionRecord {
  id: string;
  operationId: string;
  taskId: string;
  hostId: string;
  fingerprint: string;
  loginAs: string;
  runAs: string;
  plan: FileOperationPlan;
  stage: FileTransactionStage;
  revision: number;
  directory?: string;
  backup?: string;
  receipt?: { transactionId: string; fingerprint: string; targetSha256?: string; deleted: boolean };
  updatedAt: number;
}

/** No content or authentication answers may be placed in this durable record. */
export interface FileTransactionJournal {
  commit(record: FileTransactionRecord, expectedRevision: number | null, signal?: AbortSignal): Promise<FileTransactionRecord>;
  get(id: string, signal?: AbortSignal): Promise<FileTransactionRecord | undefined>;
}

export interface FileApprovalPreview {
  path: string;
  beforeSha256?: string;
  afterSha256?: string;
  before: string;
  after: string;
  encoding: 'utf8' | 'base64';
  metadata: string;
}

export interface SudoCachePolicy {
  mode: 'disabled' | 'single-password-auto';
  revision: number;
}

export type PrivateInputAnswer = string | null | { action: 'submit'; value: string; cacheAsPassword?: boolean } | { action: 'cancel' };

export function privateAnswerValue(answer: PrivateInputAnswer): string | null {
  return typeof answer === 'string' || answer === null ? answer : answer.action === 'cancel' ? null : answer.value;
}

export function isPrivateInputAnswer(value: unknown): value is PrivateInputAnswer {
  if (value === null || typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  return answer.action === 'cancel' ? Object.keys(answer).length === 1
    : answer.action === 'submit' && typeof answer.value === 'string'
      && (answer.cacheAsPassword === undefined || typeof answer.cacheAsPassword === 'boolean')
      && Object.keys(answer).every((key) => ['action', 'value', 'cacheAsPassword'].includes(key));
}
