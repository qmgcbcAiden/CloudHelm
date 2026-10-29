import { redactOutput, type OperationResult } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
/** Both synchronous results and late process evidence share the same projection. */
export function applyOperationCompletion(operation: OperationView, result: OperationResult): void {
  operation.status = result.status === 'succeeded' ? 'succeeded' : result.status === 'failed' ? 'failed' : 'unknown';
  operation.exitCode = result.exitCode;
  operation.exitObserved = ['succeeded', 'failed'].includes(result.status) && Number.isInteger(result.exitCode);
  operation.completedAt = operation.exitObserved ? operation.completedAt ?? Date.now() : undefined;
  operation.outputCapture = result.outputCapture;
  operation.authentication = result.authentication; operation.authenticationAttempts = result.authenticationAttempts;
  operation.failureKind = result.failureKind; operation.effects = result.effects; operation.privilege = result.privilege;
  operation.logRef = result.logRef;
  operation.outputTail = redactOutput(result.stdoutTail);
  if (operation.kind !== 'command' && result.stdoutTail) operation.reason = redactOutput(result.stdoutTail).slice(-2000);
}
