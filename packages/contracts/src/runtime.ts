import type { AppEvent, ClarificationAnswer, ApprovalView, HostConnectionTestResult, HostView, InputRequestView, LocalScope, OperationView, ReviewMode, ReviewSelection, ResumeReason, TaskStatus, TaskView } from './index.js';
import type { PrivateInputAnswer, SudoCachePolicy } from './private-input.js';

export interface RuntimeHost extends HostView { secret?: string }
export type RuntimeHostTestResult = Exclude<HostConnectionTestResult, { status: 'trust-required' }>
  | { status: 'trust-required'; stage: 'host' | 'jump'; fingerprint: string; expectedFingerprint?: string };
export interface RuntimeReviewProfile { selection: ReviewSelection; provider: string; modelId: string; baseUrl?: string; apiKey?: string; revision: number }
export interface RuntimeProfile { provider: string; modelId: string; baseUrl?: string; contextWindow?: number; maxTokens?: number;
  apiKey: string; credentialRevision?: string; jevKey?: string; reviewer?: RuntimeReviewProfile }

/** Worker-issued context versions; never accepted from renderer message metadata. */
export interface PreparedContext { beforeRevision: string; revision: string }

export type RuntimeCall =
  | { method: 'recover-file-transaction'; record: import('./file-transactions.js').FileTransactionViewRecord }
  | { method: 'commit-file-recovery'; operation: OperationView }
  | { method: 'prepare-message'; taskId?: string; requestId: string; document: import('./message-content.js').MessageDocument; bodies: import('./message-content.js').ReferenceBody[]; profile: RuntimeProfile; usedTokens?: number; localScopes?: LocalScope[]; hosts?: HostView[] }
  | { method: 'cancel-message'; requestId: string }

  | { method: 'set-conversation-thinking'; taskId: string; level: import('./index.js').ThinkingLevel }
  | { method: 'answer-clarification'; taskId: string; requestId: string; answers: ClarificationAnswer[] }
  | { method: 'cancel-clarification'; taskId: string; requestId: string }
  | { method: 'restore-operations'; operations: Array<{ id: string; hostId: string }> }
  | { method: 'prepare-operation-risk'; operationId: string; hostId: string }
  | { method: 'commit-operation-risk'; operation: OperationView }
  | { method: 'connect'; host: RuntimeHost; jump?: RuntimeHost }
  | { method: 'test-host'; host: RuntimeHost; jump?: RuntimeHost }
  | { method: 'disconnect'; hostId: string }
  | { method: 'set-review-key'; jevKey?: string }
  | { method: 'set-review-profile'; taskId: string; reviewer: RuntimeReviewProfile }
  | { method: 'update-conversation-review-mode'; taskId: string; hostId: string; mode: ReviewMode; revision: number }
  | { method: 'request-ai-denial-review'; taskId: string; operationId: string }
  | { method: 'test-model'; profile: RuntimeProfile }
  | { method: 'set-conversation-model'; taskId: string; profile: RuntimeProfile }
  | { method: 'stop-operation'; taskId: string }
  | { method: 'has-task'; taskId: string }
  | { method: 'update-host-safety'; hostId: string; mode: ReviewMode; protectedReadPaths: string[]; protectedWritePaths: string[]; revision: number; sudoCachePolicy?: SudoCachePolicy }
  | { method: 'open-terminal'; hostId: string }
  | { method: 'close-terminal'; terminalId: string }
  | { method: 'terminal-input'; terminalId: string; data: string; humanIntent: boolean }
  | { method: 'stop-terminal'; terminalId: string }
  | { method: 'resize'; terminalId: string; cols: number; rows: number }
  | { method: 'list-remote'; hostId: string; path: string }
  | { method: 'start-task'; intent?: string; document?: import('./message-content.js').MessageDocument; initialMessage?: string; thinkingLevel?: import('./index.js').ThinkingLevel; task: TaskView; hosts: RuntimeHost[]; profile: RuntimeProfile; priorOperations?: OperationView[]; sessionDirectory: string; restored?: boolean }
  | { method: 'authorize-task'; taskId: string; hosts: RuntimeHost[]; localScopes: LocalScope[]; prepared?: PreparedContext & { text: string } }
  | { method: 'task-message'; intent?: string; taskId: string; text: string; preparedRevision?: string; document?: import('./message-content.js').MessageDocument }
  | { method: 'decide-approval'; approvalId: string; approved: boolean }
  | { method: 'answer-input'; requestId: string; answer: PrivateInputAnswer }
  | { method: 'cancel-input'; requestId: string }
  | { method: 'pause-task' | 'resume-task'; taskId: string }
  | { method: 'delete-task'; taskId: string };

export interface LogPage { text: string; nextCursor: number; more: boolean }

export type RuntimeMessage =
  | import('./file-previews.js').FilePreviewMessage
  | import('./file-transactions.js').FileJournalRequest
  | { fileJournalResult: import('./file-transactions.js').FileJournalResult }
  | import('./runtime-resources.js').RuntimeResourceRequest
  | import('./runtime-resources.js').RuntimeResourceResult
  | import('./request-budget-runtime.js').BudgetRequestMessage
  | { budgetResult: import('./request-budget-runtime.js').BudgetResult }
  | { diagnostic: import('./diagnostics.js').DiagnosticRecord }
  | { readLog: { id: string; taskId: string; operationId: string; cursor: number } }
  | { logResult: { id: string; value?: LogPage; error?: string } }
  | { id: string; call: RuntimeCall }
  | { id: string; result?: unknown; error?: string; hostFingerprint?: string }
  | { event: AppEvent }
  | { event: { type: 'approval-open'; value: ApprovalView } }
  | { event: { type: 'approval-close'; id: string } }
  | { event: { type: 'input-open'; value: InputRequestView } }
  | { event: { type: 'input-close'; id: string } }
  | { event: { type: 'operation'; value: OperationView } }
  | { event: { type: 'task-status'; taskId: string; status: TaskStatus; summary?: string; resumeReason?: ResumeReason; requestCount?: number } }
  | { event: { type: 'host-status'; hostId: string; status: HostView['status'] } };

export interface HostSafetyConfig { mode: ReviewMode; protectedReadPaths: string[]; protectedWritePaths: string[] }
