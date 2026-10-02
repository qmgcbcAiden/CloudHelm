import type { AppEvent, ConversationMessage, ApprovalView, HostConnectionTestResult, HostView, InputRequestView, LocalScope, OperationView, ReviewMode, TaskStatus, TaskView } from './index.js';

export interface RuntimeHost extends HostView { secret?: string }
export type RuntimeHostTestResult = Exclude<HostConnectionTestResult, { status: 'trust-required' }>
  | { status: 'trust-required'; stage: 'host' | 'jump'; fingerprint: string; expectedFingerprint?: string };
export interface RuntimeProfile { provider: string; modelId: string; baseUrl?: string; apiKey: string; credentialRevision?: string; jevKey?: string }

export type RuntimeCall =
  | { method: 'restore-operations'; operations: Array<{ id: string; hostId: string }> }
  | { method: 'connect'; host: RuntimeHost; jump?: RuntimeHost }
  | { method: 'test-host'; host: RuntimeHost; jump?: RuntimeHost }
  | { method: 'disconnect'; hostId: string }
  | { method: 'set-review-key'; jevKey?: string }
  | { method: 'test-model'; profile: RuntimeProfile }
  | { method: 'set-conversation-model'; taskId: string; profile: RuntimeProfile }
  | { method: 'stop-operation'; taskId: string }
  | { method: 'has-task'; taskId: string }
  | { method: 'update-host-safety'; hostId: string; mode: ReviewMode; protectedPaths: string[]; revision: number }
  | { method: 'open-terminal'; hostId: string }
  | { method: 'close-terminal'; terminalId: string }
  | { method: 'terminal-input'; terminalId: string; data: string; humanIntent: boolean }
  | { method: 'take-over' | 'hand-back'; terminalId: string }
  | { method: 'resize'; terminalId: string; cols: number; rows: number }
  | { method: 'list-remote'; hostId: string; path: string }
  | { method: 'start-task'; task: TaskView; hosts: RuntimeHost[]; profile: RuntimeProfile; priorOperations?: OperationView[]; history?: ConversationMessage[]; restored?: boolean }
  | { method: 'authorize-task'; taskId: string; hosts: RuntimeHost[]; localScopes: LocalScope[] }
  | { method: 'task-message'; taskId: string; text: string }
  | { method: 'decide-approval'; approvalId: string; approved: boolean }
  | { method: 'answer-input'; requestId: string; answer: string }
  | { method: 'cancel-input'; requestId: string }
  | { method: 'pause-task' | 'resume-task'; taskId: string };

export interface LogPage { text: string; nextCursor: number; more: boolean }

export type RuntimeMessage =
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
  | { event: { type: 'task-status'; taskId: string; status: TaskStatus; summary?: string; requestCount?: number } }
  | { event: { type: 'host-status'; hostId: string; status: HostView['status'] } };

export interface HostSafetyConfig { mode: ReviewMode; protectedPaths: string[] }
