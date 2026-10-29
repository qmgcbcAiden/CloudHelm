import { createHash } from 'node:crypto';
import type { ProposedOperation } from './model.js';

export function operationFingerprint(operation: ProposedOperation): string {
  return fingerprint(operation, true);
}

function fingerprint(operation: ProposedOperation, approval: boolean): string {
  const { scope } = operation;
  const bound = {
    taskId: scope.taskId,
    hostId: scope.hostId,
    cwd: scope.cwd,
    runAs: scope.runAs,
    loginAs: scope.loginAs, sessionId: scope.sessionId, connectionGeneration: scope.connectionGeneration,
    terminalId: scope.terminalId,
    terminalGeneration: scope.terminalGeneration,
    policyRevision: scope.policyRevision,
    conversationRevision: scope.conversationRevision,
    reviewerRevision: scope.reviewerRevision,
    allowedWorkingRoots: scope.allowedWorkingRoots,
    protectedPaths: scope.protectedPaths,
    protectedReadPaths: scope.protectedReadPaths,
    protectedWritePaths: scope.protectedWritePaths,
    ...(approval ? { sudoCachePolicy: scope.sudoCachePolicy } : {}),
    kind: operation.kind,
    payload: operation.kind === 'command' ? approval ? [operation.command, operation.executionPlan] : operation.command
      : operation.kind === 'write-file' ? [operation.path, operation.content, ...(approval ? [operation.filePlan] : [])]
      : operation.kind === 'upload' ? [operation.localPath, operation.remotePath, operation.localRoot, operation.contentSha256, operation.size, ...(approval ? [operation.filePlan] : [])]
      : operation.kind === 'runtime' ? operation.runtime : approval ? [operation.path, operation.filePlan] : operation.path
  };
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex');
}

/** Replay identity excludes transient approval leases; it never authorizes execution. */
export function operationIntentKey(operation: ProposedOperation): string {
  // Retain the v11 semantic payload encoding so historical denial/unknown records
  // remain replay barriers. Approval hashes separately bind every new plan field.
  return fingerprint({ ...operation, scope: { ...operation.scope,
    taskId: '', terminalId: '', terminalGeneration: 0, policyRevision: 0, conversationRevision: 0, reviewerRevision: 0,
    connectionGeneration: undefined, sessionId: undefined, allowedWorkingRoots: [], protectedPaths: [],
    protectedReadPaths: [], protectedWritePaths: [], goal: ''
  } }, false);
}
