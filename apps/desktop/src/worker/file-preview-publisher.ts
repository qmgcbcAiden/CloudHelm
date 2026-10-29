import type { SafetyGate } from '@cloudhelm/application';
import type { FileApprovalPreview, ProposedOperation } from '@cloudhelm/core';
import type { FilePreviewEnvelope } from '@cloudhelm/contracts';

/** Holds a prepared body only until its metadata-only operation is published. */
export class FilePreviewPublisher {
  private readonly pending = new Map<string, FileApprovalPreview>();
  constructor(private readonly publish: (value: FilePreviewEnvelope) => void) {}
  async execute(gate: SafetyGate, operation: ProposedOperation, signal?: AbortSignal, manualReview = false, preview?: FileApprovalPreview) {
    if (preview) this.pending.set(operation.id, preview);
    try { return await gate.execute(operation, signal, manualReview, preview); }
    finally { this.pending.delete(operation.id); }
  }
  proposed(operation: ProposedOperation): void {
    const preview = this.pending.get(operation.id);
    if (!preview || !('filePlan' in operation) || !operation.filePlan) return;
    this.pending.delete(operation.id);
    this.publish({ operationId: operation.id, taskId: operation.scope.taskId, hostId: operation.scope.hostId,
      transactionId: operation.filePlan.transactionId, preview });
  }
}
