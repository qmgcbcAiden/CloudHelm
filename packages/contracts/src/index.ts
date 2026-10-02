import { Type, type Static } from 'typebox';

export const HostDraftSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  address: Type.String({ minLength: 1, maxLength: 255 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  username: Type.String({ minLength: 1, maxLength: 128 }),
  auth: Type.Union([Type.Literal('agent'), Type.Literal('private-key'), Type.Literal('password')]),
  privateKeyPath: Type.Optional(Type.String()),
  jumpHostId: Type.Optional(Type.String())
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
export type TaskStatus = 'draft' | 'running' | 'waiting-review' | 'human-control' | 'recovering' | 'paused' | 'answered' | 'ready-for-review' | 'accepted' | 'failed';
export interface ModelChoice { provider: string; modelId: string }
export interface ModelProfileDraft extends ModelChoice { baseUrl?: string; apiKey?: string }
export interface PlanStep { id: string; title: string; status: 'pending' | 'running' | 'done' | 'blocked' }
export interface VerificationReport { summary: string; access: string[]; evidenceOperationIds: string[]; changes: string[]; recovery: string[] }
export interface ConversationMessage { taskId: string; role: 'agent' | 'user' | 'system'; text: string; createdAt: number; model?: ModelChoice }
export interface TerminalViewState { id: string; hostId: string; taskId?: string; state: 'agent' | 'human' | 'suspended' | 'closed' }
export interface ConversationStart { hostId: string | null; message: string; model?: ModelChoice; localSelectionTokens: string[] }
export interface LocalScope { path: string; kind: 'file' | 'directory' }

export interface HostView extends HostDraft {
  id: string;
  archived?: boolean;
  previousHostId?: string;
  fingerprint?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'changed-key' | 'error';
  protectedPaths: string[];
  defaultMode: ReviewMode;
  policyRevision: number;
}

export interface TaskView {
  id: string;
  goal: string;
  hostIds: string[];
  localScopes: LocalScope[];
  status: TaskStatus;
  modelId: string;
  provider?: string;
  credentialRevision?: string;
  baseUrl?: string;
  plan?: PlanStep[];
  report?: VerificationReport;
  requestCount: number;
  requestLimit: number;
  createdAt: number;
  updatedAt: number;
  summary?: string;
}

export interface OperationView {
  id: string;
  taskId: string;
  hostId: string;
  kind: 'command' | 'write-file' | 'upload' | 'delete-path';
  preview: string;
  status: 'proposed' | 'approved' | 'running' | 'succeeded' | 'failed' | 'denied' | 'unknown';
  reason?: string;
  exitCode?: number;
  logRef?: string;
  outputTail?: string;
  model?: ModelChoice;
  createdAt: number;
}

export interface ApprovalView {
  id: string;
  taskId: string;
  operationId: string;
  hostId: string;
  fingerprint: string;
  title: string;
  explanation: string;
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
}

export interface AppSnapshot {
  hosts: HostView[];
  conversations: TaskView[];
  terminals: TerminalViewState[];
  operations: OperationView[];
  approvals: ApprovalView[];
  inputs: InputRequestView[];
  messages: ConversationMessage[];
  profile: { provider: string; modelId: string; baseUrl?: string; hasKey: boolean; hasJevKey: boolean };
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
  hasKey: boolean;
}

export type AppEvent =
  | { type: 'snapshot'; value: AppSnapshot }
  | { type: 'terminal-data'; terminalId: string; data: string; operationId?: string }
  | { type: 'terminal-state'; terminalId: string; hostId: string; taskId?: string; state: 'agent' | 'human' | 'suspended' | 'closed' }
  | ({ type: 'task-message' } & ConversationMessage)
  | { type: 'model-request'; taskId: string; model: ModelChoice; request: number; createdAt: number }
  | { type: 'work-progress'; taskId: string; plan: PlanStep[] }
  | { type: 'work-report'; taskId: string; report?: VerificationReport };

export interface DesktopAPI {
  snapshot(): Promise<AppSnapshot>;
  addHost(host: HostDraft): Promise<HostView>;
  editHost(hostId: string, host: HostDraft, newSecret?: string): Promise<HostView>;
  testHostConnection(input: HostConnectionTestInput): Promise<HostConnectionTestResult>;
  setHostSecret(hostId: string, secret: string): Promise<void>;
  updateHostSafety(hostId: string, mode: ReviewMode, protectedPaths: string[]): Promise<void>;
  listModelProviders(): Promise<ModelProviderView[]>;
  modelProviderSettings(providerId: string): Promise<ModelProviderSettings>;
  saveModelProfile(profile: ModelProfileDraft): Promise<void>;
  testModelConnection(profile: ModelProfileDraft): Promise<{ latencyMs: number }>;
  availableModels(): Promise<Array<ModelChoice & { name: string }>>;
  saveReviewSettings(settings: { jevKey?: string; disableJev?: boolean }): Promise<void>;
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
  takeOver(terminalId: string): Promise<void>;
  handBack(terminalId: string): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  startConversation(input: ConversationStart): Promise<TaskView>;
  sendMessage(conversationId: string, message: string, localSelectionTokens?: string[]): Promise<void>;
  setConversationModel(conversationId: string, model: ModelChoice): Promise<void>;
  stopOperation(conversationId: string): Promise<void>;
  decideApproval(approvalId: string, approved: boolean): Promise<void>;
  answerInput(requestId: string, answer: string): Promise<void>;
  cancelInput(requestId: string): Promise<void>;
  pauseConversation(taskId: string): Promise<void>;
  resumeConversation(taskId: string): Promise<void>;
  acceptConversation(taskId: string): Promise<void>;
  listRemote(hostId: string, path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>>;
  readTerminalLog(terminalId: string): Promise<string>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
