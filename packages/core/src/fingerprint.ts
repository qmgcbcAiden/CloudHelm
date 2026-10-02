import { createHash } from 'node:crypto';
import type { ProposedOperation } from './model.js';

export function operationFingerprint(operation: ProposedOperation): string {
  const { scope } = operation;
  const bound = {
    taskId: scope.taskId,
    hostId: scope.hostId,
    cwd: scope.cwd,
    runAs: scope.runAs,
    terminalId: scope.terminalId,
    terminalGeneration: scope.terminalGeneration,
    policyRevision: scope.policyRevision,
    allowedWorkingRoots: scope.allowedWorkingRoots,
    protectedPaths: scope.protectedPaths,
    kind: operation.kind,
    payload: operation.kind === 'command' ? operation.command
      : operation.kind === 'write-file' ? [operation.path, operation.content]
      : operation.kind === 'upload' ? [operation.localPath, operation.remotePath, operation.localRoot, operation.contentSha256, operation.size]
      : operation.path
  };
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex');
}
