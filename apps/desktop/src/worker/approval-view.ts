import { redactOutput, type ApprovalRequest } from '@cloudhelm/core';
import type { ApprovalView } from '@cloudhelm/contracts';
import { approvalPresentation } from './approval-presentation.js';
import { operationPreview } from './operation-preview.js';

export function approvalView(request: ApprovalRequest): ApprovalView {
  const presentation = approvalPresentation(request);
  return {
          id: request.id, taskId: request.operation.scope.taskId, operationId: request.operation.id,
          hostId: request.operation.scope.hostId, fingerprint: request.fingerprint, title: presentation.title,
          explanation: presentation.explanation,
          preview: operationPreview(request.operation), account: request.operation.scope.runAs,
          cwd: request.operation.scope.cwd, impact: request.impact,
          targets: request.targets?.map((target) => redactOutput(target)),
          recovery: presentation.recovery, filePreviewOperationId: request.filePreview ? request.operation.id : undefined,
          expiresAt: request.expiresAt
        };
}
