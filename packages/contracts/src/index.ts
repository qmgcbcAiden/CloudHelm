import { Type, type Static } from 'typebox';
import type { VerificationReport, VerificationState } from './verification-report.js';
import type { PrivateInputAnswer, SudoCachePolicy } from './private-input.js';
export * from './verification-report.js';
export * from './request-budget.js';
export * from './request-budget-runtime.js';
export * from './private-input.js';

export const HostDraftSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  address: Type.String({ minLength: 1, maxLength: 255 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  username: Type.String({ minLength: 1, maxLength: 128 }),
  auth: Type.Union([Type.Literal('agent'), Type.Literal('private-key'), Type.Literal('password')]),
  privateKeyPath: Type.Optional(Type.String()),
  jumpHostId: Type.Optional(Type.String()),
  runtimeDirectory: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, pattern: '^/[^\\u0000-\\u001f]*$' }))
});

export type HostDraft = Static<typeof HostDraftSchema>;
export interface HostConnectionTestInput { host: HostDraft; editingHostId?: string; secret?: string; trustRequestId?: string }
export type HostTestFailure = 'auth' | 'credentials' | 'agent' | 'key-file' | 'timeout' | 'network' | 'interactive' | 'unknown';
export type HostConnectionTestResult =
  | { status: 'success'; latencyMs: number }
  | { status: 'failed'; code: HostTestFailure; stage: 'host' | 'jump' }
  | { status: 'trust-required'; requestId: string; stage: 'host' | 'jump'; address: string; port: number;
    fingerprint: string; expectedFingerprint?: string; expiresAt: number };
export type ReviewMode = 'ask' | 'ai-review' | 'permissive';
export type ReviewSelection = { kind: 'current' } | { kind: 'jev' } | { kind: 'model'; provider: string; modelId: string };
export interface ClarificationQuestion {
  id: string;
  prompt: string;
  options?: Array<{ value: string; label: string; description?: string; recommended?: boolean }>;
}
export interface ClarificationAnswer { id: string; value: string; custom?: boolean }
export interface ClarificationRequest {
  id: string; taskId: string; toolCallId: string; generation: string;
  questions: ClarificationQuestion[]; createdAt: number; expiresAt: number;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  answers?: ClarificationAnswer[];
}

export type TaskStatus = 'draft' | 'running' | 'waiting-review' | 'waiting-user' | 'human-control' | 'recovering' | 'paused' | 'answered' | 'failed';
/** Only these backend-owned reasons permit a host-initiated continuation. */
export type ResumeReason = 'verify' | 'report' | 'interrupted' | 'model' | 'budget-exhausted';

/**
 * How an uncertain remote outcome was resolved. It never rewrites the recorded
 * outcome: `evidence` observed the real result; `risk-accepted` means the user
 * explicitly took over an outcome that could not be proven after inspection.
 */
export interface OperationReconciliation {
  kind: 'evidence' | 'risk-accepted';
  /** Observed result, only for kind `evidence`. */
  outcome?: 'succeeded' | 'failed';
  /** Newer successful inspection operations from the same host, only for kind `evidence`. */
  evidenceOperationIds?: string[];
  /** Conversation from which the user initiated recovery, if any. */
  sourceTaskId?: string;
  explanation: string;
  at: number;
}

/** Statuses in which a conversation still owns live work and must not be deleted. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['running', 'waiting-review', 'waiting-user', 'human-control', 'recovering'];
export function isActiveTaskStatus(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ThinkingView { levels: ThinkingLevel[]; selected: ThinkingLevel; effective: ThinkingLevel; pending: boolean }

export interface ModelChoice { provider: string; modelId: string }
export interface ContextBudgetView {
  pendingInputReserve?: number;
  contextWindow: number; usedTokens: number; outputReserve: number; safetyMargin: number; availableInput: number;
  source: 'provider' | 'estimate';
}
export interface ModelCapacityView { contextWindow: number; maxOutputTokens: number; source: 'catalog' | 'custom-settings' }
export interface ContextUsageView {
  capacity?: ModelCapacityView;
  budget?: ContextBudgetView;
  model: ModelChoice;
  request: number;
  usedTokens: number | null;
  contextWindow: number | null;
  source: 'provider' | 'estimate' | 'unknown';
  updatedAt: number;
}
export interface ModelProfileDraft extends ModelChoice { baseUrl?: string; apiKey?: string; contextWindow?: number; maxTokens?: number }
export interface PlanStep { id: string; title: string; status: 'pending' | 'running' | 'done' | 'blocked' }
export type InterruptionSource = 'stop-button' | 'ctrl-c' | 'terminal-close';
export interface UserInterruption { source: InterruptionSource; requestedAt: number; operationIds: string[] }
export interface ReasoningView {
  text: string; status: 'streaming' | 'complete' | 'interrupted' | 'unavailable';
  kind: 'thinking' | 'summary'; redacted?: boolean;
}
export interface ReasoningProgress { id: string; createdAt: number; model: { provider: string; modelId: string }; reasoning: ReasoningView }

export interface ConversationMessage {
  source?: 'input' | 'clarification' | 'assistant';
  clarificationToolCallId?: string;
  document?: import('./message-content.js').MessageDocument;
  reasoning?: ReasoningView; entryId?: string; interruption?: UserInterruption; taskId: string; role: 'agent' | 'user' | 'system'; text: string; createdAt: number; model?: ModelChoice }
export interface TerminalViewState { id: string; hostId: string; taskId?: string; state: 'agent' | 'human' | 'suspended' | 'closed'; replacementTerminalId?: string }
export interface ConversationStart { thinkingLevel?: ThinkingLevel; hostId: string | null; message: string; model?: ModelChoice; localSelectionTokens: string[] }
export interface LocalScope { path: string; kind: 'file' | 'directory' }

export interface HostView extends HostDraft {
  id: string;
  archived?: boolean;
  previousHostId?: string;
  fingerprint?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'changed-key' | 'error';
  protectedPaths: string[];
  protectedReadPaths?: string[];
  protectedWritePaths?: string[];
  defaultMode: ReviewMode;
  policyRevision: number;
  sudoCachePolicy?: SudoCachePolicy;
}

export const TaskIntentStateSchema = Type.Object({
  version: Type.Literal(1), revision: Type.Integer({ minimum: 0 }),
  originalGoal: Type.String(), currentInput: Type.String(),
  origin: Type.Union([Type.Literal('explicit'), Type.Literal('legacy')]),
  lastInputId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  // IDs already merged in this intent round; native UI replay never adds entries.
  clarifications: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }), text: Type.String() }))
});
export type TaskIntentState = Static<typeof TaskIntentStateSchema>;

export interface TaskView {
  budget?: import('./request-budget.js').RequestBudgetState;
  intent?: TaskIntentState;
  thinking?: ThinkingView;
  session?: { version: 1; id: string };
  id: string;
  goal: string;
  hostIds: string[];
  reviewModesByHost?: Record<string, ReviewMode>;
  reviewRevision?: number;
  localScopes: LocalScope[];
  status: TaskStatus;
  resumeReason?: ResumeReason;
  modelId: string;
  provider?: string;
  credentialRevision?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  plan?: PlanStep[];
  report?: VerificationReport;
  verificationState?: VerificationState;
  verificationRound?: import('./verification-v3.js').VerificationRound;
  /** Recent report revisions; the complete archive is persisted separately. */
  verificationHistory?: VerificationReport[];
  requestCount: number;
  requestLimit: number;
  createdAt: number;
  updatedAt: number;
  summary?: string;
}

export interface OperationView {
  /** Capability verified from the full operation before execution, not from its display preview. */
  fileTransactionId?: string;
  fileRecovery?: import('./file-transactions.js').FileRecoveryView;
  readOnly?: boolean;
  ruleId?: string;
  manualReviewAvailable?: boolean;
  reconciledAt?: number;
  reconciliation?: OperationReconciliation;
  intentKey?: string;
  verificationSource?: import('./verification-v3.js').VerificationSource;
  outputExpectation?: import('./verification-v3.js').OutputExpectation;
  /** Backend observed a terminal completion/code, never reconciliation prose; launch failure may still mean the payload did not start. */
  exitObserved?: boolean;
  completedAt?: number;
  /** Directory captured with the full command fingerprint, never inferred from a display preview. */
  commandSource?: { version: 1; cwd: string };
  serviceUnit?: string;
  authentication?: 'succeeded' | 'required' | 'failed';
  authenticationAttempts?: number;
  privilege?: import('./privilege.js').PrivilegeFeedbackView;
  failureKind?: 'authentication-required' | 'permission-denied' | 'authentication-failed' | 'unsupported' | 'user-action-required' | 'unresolved-prior-operation' | 'conflict' | 'unknown';
  effects?: 'none' | 'possible';
  loginAs?: string;
  runAs?: string;
  interruption?: UserInterruption;
  id: string;
  taskId: string;
  hostId: string;
  kind: 'command' | 'write-file' | 'upload' | 'delete-path' | 'runtime';
  preview: string;
  status: 'proposed' | 'approved' | 'running' | 'succeeded' | 'failed' | 'denied' | 'unknown';
  reason?: string;
  exitCode?: number;
  logRef?: string;
  outputTail?: string;
  outputCapture?: { totalChars: number; tailChars: number; truncated: boolean };
  model?: ModelChoice;
  createdAt: number;
}

/** Outcome fields the write-lock and recovery rules reason about. */
export type OperationOutcomeState = Pick<OperationView, 'readOnly' | 'status' | 'effects' | 'reconciledAt' | 'fileRecovery'>;

/**
 * True while a non-read-only operation's recorded remote outcome still gates
 * host writes and blocks acceptance. In-flight operations count as unresolved:
 * they are never resolved by guessing, only by their real completion.
 */
export function operationNeedsVerification(operation: OperationOutcomeState): boolean {
  if (operation.fileRecovery?.lockState === 'pending') return true;
  if (operation.readOnly || operation.reconciledAt) return false;
  return ['proposed', 'approved', 'running', 'unknown'].includes(operation.status)
    || (operation.status === 'failed' && operation.effects !== 'none');
}

/**
 * True when the outcome is terminal-unknown and may be resolved either by fresh
 * same-host evidence or by an explicit user risk acceptance. Running operations
 * are excluded: the user cannot accept an outcome that is still being produced.
 */
export function operationOutcomeResolvable(operation: OperationOutcomeState): boolean {
  if (operation.readOnly || operation.reconciledAt) return false;
  return operation.status === 'unknown' || (operation.status === 'failed' && operation.effects !== 'none');
}

/** First persisted resolution wins; delayed snapshots can still add real observations. */
export function retainOperationResolution(previous: OperationView | undefined, incoming: OperationView): OperationView {
  if (!previous) return incoming;
  if (previous.id !== incoming.id || previous.taskId !== incoming.taskId
    || previous.hostId !== incoming.hostId || previous.kind !== incoming.kind) {
    throw new Error('Operation identity changed while applying an observation');
  }
  if (!previous.reconciledAt) return incoming;
  // Never erase an acceptance or replace it with a competing assessment, nor
  // drop the full source/evidence audit metadata from the canonical record.
  if (incoming.reconciledAt && (incoming.reconciledAt !== previous.reconciledAt
    || incoming.reconciliation?.kind !== previous.reconciliation?.kind
    || incoming.reconciliation?.outcome !== previous.reconciliation?.outcome)) return previous;
  return { ...incoming, fileTransactionId: previous.fileTransactionId ?? incoming.fileTransactionId,
    fileRecovery: previous.fileRecovery?.lockState === 'pending' && incoming.fileRecovery?.lockState === 'confirmed'
      ? incoming.fileRecovery : previous.fileRecovery ?? incoming.fileRecovery, reconciledAt: previous.reconciledAt, reconciliation: previous.reconciliation };
}

export interface ApprovalView {
  id: string;
  taskId: string;
  operationId: string;
  hostId: string;
  fingerprint: string;
  title: string;
  explanation: string;
  account?: string;
  cwd?: string;
  impact?: 'ordinary' | 'high' | 'unknown';
  targets?: string[];
  recovery?: string;
  filePreviewOperationId?: string;
  preview: string;
  expiresAt: number;
}

export interface InputRequestView {
  id: string;
  taskId: string;
  operationId: string;
  hostId: string;
  title: string;
  explanation: string;
  kind: 'confirmation' | 'text' | 'secret' | 'otp';
  choices?: string[];
  expiresAt: number;
  allowPasswordCache?: boolean;
}

export interface ExecutionView {
  model: 'running' | 'idle';
  remote: 'running' | 'unknown' | 'idle';
  stopping: boolean;
  canStop: boolean;
}

export interface AppSnapshot {
  runtimeResources?: import('./runtime-resources.js').RuntimeResourceView[];
  reasoningProgress?: Record<string, ReasoningProgress>;
  execution?: Record<string, ExecutionView>;
  contextUsage?: Record<string, ContextUsageView>;
  contextCompaction?: Record<string, 'running' | 'complete' | 'failed'>;
  hosts: HostView[];
  conversations: TaskView[];
  terminals: TerminalViewState[];
  operations: OperationView[];
  approvals: ApprovalView[];
  inputs: InputRequestView[];
  clarifications?: ClarificationRequest[];
  messages: ConversationMessage[];
  profile: { provider: string; modelId: string; baseUrl?: string; hasKey: boolean; hasJevKey: boolean; reviewer?: ReviewSelection };
}

export interface ModelProviderView {
  id: string;
  name: string;
  defaultBaseUrl?: string;
  models: Array<{ id: string; name: string }>;
}

export interface ModelProviderSettings {
  modelId?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  hasKey: boolean;
}

export type AppEvent =
  | { type: 'terminal-command'; terminalId: string; generation: number; phase: 'start' | 'end' | 'unavailable'; command?: string; exitCode?: number }
  | { type: 'message-preparation'; requestId: string; referenceId?: string; status: 'checking' | 'compressing' | 'ready'; context?: ContextUsageView; summaryRequests?: { used: number; limit: 32 } }
  | { type: 'reasoning-progress'; taskId: string; value: ReasoningProgress | null }
  | { type: 'thinking'; taskId: string; value: ThinkingView }
  | { type: 'execution'; taskId: string; value: ExecutionView }
  | { type: 'context-usage'; taskId: string; value: ContextUsageView }
  | { type: 'clarification'; value: ClarificationRequest }
  | { type: 'task-intent'; taskId: string; value: TaskIntentState }
  | { type: 'snapshot'; value: AppSnapshot }
  | { type: 'terminal-data'; terminalId: string; data: string; operationId?: string }
  | { type: 'terminal-state'; terminalId: string; hostId: string; taskId?: string; state: 'agent' | 'human' | 'suspended' | 'closed' }
  | { type: 'terminal-replaced'; previousTerminalId: string; terminalId: string }
  | ({ type: 'task-message' } & ConversationMessage)
  | { type: 'context-compaction'; taskId: string; status: 'running' | 'complete' | 'failed' }
  | { type: 'model-request'; purpose?: 'conversation' | 'compaction'; roundId?: string; logicalRequestId?: string; attempt?: number;
      transport?: 'http' | 'opaque'; taskId: string; model: ModelChoice; request: number; createdAt: number }
  | { type: 'work-progress'; taskId: string; plan: PlanStep[] }
  | { type: 'work-report'; taskId: string; report?: VerificationReport }
  | { type: 'verification-state'; taskId: string; value?: VerificationState }
  | { type: 'verification-round'; taskId: string; value: import('./verification-v3.js').VerificationRound };

export interface ShortcutSettings { bindings: Record<string, string>; enabled: boolean }

export interface DesktopAPI {
  quoteTerminal(input: import('./message-content.js').TerminalQuoteRequest): Promise<import('./message-content.js').ReferenceInfo>;
  readReference(id: string): Promise<import('./message-content.js').ReferenceBody>;
  sendStructured(input: import('./message-content.js').StructuredSend): Promise<{ conversationId: string }>;
  cancelMessage(requestId: string): Promise<void>;

  snapshot(): Promise<AppSnapshot>;
  /** Version of the packaged application, sourced from apps/desktop/package.json. */
  appVersion(): Promise<string>;
  addHost(host: HostDraft): Promise<HostView>;
  editHost(hostId: string, host: HostDraft, newSecret?: string): Promise<HostView>;
  testHostConnection(input: HostConnectionTestInput): Promise<HostConnectionTestResult>;
  setHostSecret(hostId: string, secret: string): Promise<void>;
  updateHostReviewMode(hostId: string, mode: ReviewMode): Promise<void>;
  updateHostSafety(hostId: string, mode: ReviewMode, protectedReadPaths: string[], protectedWritePaths: string[], sudoCacheMode?: SudoCachePolicy['mode']): Promise<void>;
  updateConversationReviewMode(taskId: string, hostId: string, mode: ReviewMode): Promise<void>;
  requestAiDenialReview(taskId: string, operationId: string): Promise<void>;
  recoverFileTransaction(transactionId: string): Promise<import('./file-transactions.js').FileRecoveryView>;
  readFilePreview(operationId: string): Promise<import('./file-previews.js').FilePreviewResponse>;
  readRecoveryOperationLog(operationId: string, cursor: number): Promise<{ text: string; nextCursor: number; more: boolean }>;
  acceptOperationRisk(operationId: string, explanation: string, sourceTaskId?: string, evidenceOperationIds?: string[]): Promise<void>;
  listModelProviders(): Promise<ModelProviderView[]>;
  modelProviderSettings(providerId: string): Promise<ModelProviderSettings>;
  saveModelProfile(profile: ModelProfileDraft): Promise<void>;
  testModelConnection(profile: ModelProfileDraft): Promise<{ latencyMs: number }>;
  availableModels(): Promise<Array<ModelChoice & { name: string; thinkingLevels?: ThinkingLevel[] }>>;
  saveReviewSettings(settings: { jevKey?: string; disableJev?: boolean; reviewer?: ReviewSelection }): Promise<void>;
  shortcuts(): Promise<ShortcutSettings>;
  saveShortcuts(settings: ShortcutSettings): Promise<void>;
  /** Clipboard access for user-initiated menu actions; contents are never logged. */
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  connectHost(hostId: string): Promise<void>;
  disconnectHost(hostId: string): Promise<void>;
  deleteHost(hostId: string): Promise<void>;
  trustHostKey(hostId: string, fingerprint: string): Promise<void>;
  openTerminal(hostId: string): Promise<string>;
  closeTerminal(terminalId: string): Promise<void>;
  selectLocalPath(kind: LocalScope['kind']): Promise<{ token: string; scope: LocalScope } | null>;
  selectPrivateKey(): Promise<string | null>;
  terminalInput(terminalId: string, data: string): Promise<void>;
  terminalProtocolResponse(terminalId: string, data: string): Promise<void>;
  stopTerminal(terminalId: string): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  startConversation(input: ConversationStart): Promise<TaskView>;
  sendMessage(conversationId: string, message: string, localSelectionTokens?: string[]): Promise<void>;
  setConversationThinking(conversationId: string, level: ThinkingLevel): Promise<void>;
  setConversationModel(conversationId: string, model: ModelChoice): Promise<void>;
  answerClarification(taskId: string, requestId: string, answers: ClarificationAnswer[]): Promise<void>;
  cancelClarification(taskId: string, requestId: string): Promise<void>;
  stopOperation(conversationId: string): Promise<void>;
  decideApproval(approvalId: string, approved: boolean): Promise<void>;
  answerInput(requestId: string, answer: PrivateInputAnswer): Promise<void>;
  cancelInput(requestId: string): Promise<void>;
  pauseConversation(taskId: string): Promise<void>;
  resumeConversation(taskId: string): Promise<void>;
  /** Re-project a settled automatic report from existing records only; no SSH/model execution. */
  rebuildVerificationReport(taskId: string): Promise<void>;
  extendRequestBudget(input: import('./request-budget.js').ExtendRequestBudget): Promise<import('./request-budget.js').BudgetExtensionResult>;
  listRemote(hostId: string, path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>>;
  readTerminalLog(terminalId: string): Promise<string>;
  /** Permanently removes a finished conversation with its records and terminal logs. */
  deleteConversation(id: string): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

export * from './message-content.js';

export * from './file-transactions.js';
export * from './file-previews.js';

export * from './runtime-resources.js';
