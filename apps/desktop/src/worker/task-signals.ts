import type { DiagnosticEvent, OperationScope } from '@cloudhelm/core';
import type { SafetyGate } from '@cloudhelm/application';
import type { AppEvent, ApprovalView, BudgetCommand, BudgetValue, OperationView, ResumeReason, TaskStatus } from '@cloudhelm/contracts';

export interface TaskSignals {
  filePreview?(value: import('@cloudhelm/contracts').FilePreviewEnvelope): void;
  budget?(command: BudgetCommand, signal?: AbortSignal): Promise<BudgetValue>;
  clearCredentials?(): void;
  cleanupRuntime?(gate: SafetyGate, knownIdle: boolean, refresh: (scope: OperationScope) => OperationScope): Promise<void>;
  abandonRuntime?(): void;
  diagnostic?(event: DiagnosticEvent): void;
  event(event: AppEvent | { type: 'approval-open'; value: ApprovalView } | { type: 'approval-close'; id: string }
    | { type: 'operation'; value: OperationView } | { type: 'task-status'; taskId: string; status: TaskStatus; summary?: string; resumeReason?: ResumeReason; requestCount?: number }): void;
  requestApproval(view: ApprovalView): Promise<boolean>;
  cancelApproval(id: string): void;
}
