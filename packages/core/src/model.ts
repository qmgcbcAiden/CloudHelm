export type ReviewMode = 'ask' | 'ai-review' | 'permissive';

export interface OperationScope {
  taskId: string;
  hostId: string;
  cwd: string;
  runAs: string;
  terminalId: string;
  terminalGeneration: number;
  policyRevision: number;
  allowedWorkingRoots: string[];
  protectedPaths: string[];
  goal: string;
}

export type ProposedOperation =
  | { id: string; kind: 'command'; command: string; scope: OperationScope }
  | { id: string; kind: 'write-file'; path: string; content: string; scope: OperationScope }
  | { id: string; kind: 'upload'; localPath: string; remotePath: string; localRoot: string; contentSha256: string; size: number; scope: OperationScope }
  | { id: string; kind: 'delete-path'; path: string; scope: OperationScope };

export interface CommandCall {
  name: string;
  args: string[];
  dynamic: boolean;
  redirects: boolean;
}

export interface CommandAnalysis {
  calls: CommandCall[];
  redirectTargets: string[];
  hasExpansion: boolean;
  hasPipeline: boolean;
  hasCompound: boolean;
  hasRedirection: boolean;
  hasError: boolean;
  raw: string;
}

export interface SafetyDecision {
  verdict: 'allow' | 'ask' | 'evaluate' | 'deny' | 'error';
  ruleId: string;
  reason: string;
}

export interface SafetySettings {
  mode: ReviewMode;
  revision: number;
}

export interface OperationResult {
  operationId: string;
  status: 'succeeded' | 'failed' | 'unknown' | 'handed-over';
  exitCode?: number;
  stdoutTail: string;
  logRef?: string;
  cwd?: string;
  /** Runtime-only evidence that a handed-over PTY command actually left the foreground. */
  remoteCompletion?: Promise<'exited' | 'unknown'>;
}

export interface ApprovalRequest {
  id: string;
  operation: ProposedOperation;
  fingerprint: string;
  reason: string;
  expiresAt: number;
}

export interface InputRequest {
  id: string;
  operationId: string;
  taskId: string;
  hostId: string;
  terminalId: string;
  terminalGeneration: number;
  connectionGeneration: number;
  kind: 'confirmation' | 'text' | 'secret' | 'otp';
  recipient: string;
  reason: string;
  prompt: string;
  choices?: string[];
  expiresAt: number;
}
