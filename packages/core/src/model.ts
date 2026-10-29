export type ReviewMode = 'ask' | 'ai-review' | 'permissive';

export interface OperationIntent {
  originalGoal: string;
  currentInput: string;
  clarifications: Array<{ id: string; text: string }>;
  origin: 'explicit' | 'legacy';
}

export interface OperationScope {
  taskId: string;
  hostId: string;
  cwd: string;
  runAs: string;
  loginAs?: string;
  sessionId?: string;
  connectionGeneration?: number;
  terminalId: string;
  terminalGeneration: number;
  policyRevision: number;
  conversationRevision?: number;
  reviewerRevision?: number;
  sudoCachePolicy?: import('./remote-runtime.js').SudoCachePolicy;
  allowedWorkingRoots: string[];
  /** Legacy combined rule; new scopes set the directional lists below. */
  protectedPaths: string[];
  protectedReadPaths?: string[];
  protectedWritePaths?: string[];
  goal: string;
  /** Backend-maintained intent, never reconstructed from display text or remote output. */
  intent?: OperationIntent;
}

export type ProposedOperation =
  | { id: string; kind: 'command'; command: string; serviceUnit?: string;
      executionPlan?: import('./remote-runtime.js').CommandExecutionPlan;
      outputExpectation?: { expectedOutput: string; expectedExitCode?: number }; scope: OperationScope }
  | { id: string; kind: 'write-file'; path: string; content: string; filePlan?: import('./remote-runtime.js').FileOperationPlan; scope: OperationScope }
  | { id: string; kind: 'upload'; localPath: string; remotePath: string; localRoot: string; contentSha256: string; size: number; filePlan?: import('./remote-runtime.js').FileOperationPlan; scope: OperationScope }
  | { id: string; kind: 'delete-path'; path: string; filePlan?: import('./remote-runtime.js').FileOperationPlan; scope: OperationScope }
  | { id: string; kind: 'runtime'; runtime: import('./remote-runtime.js').RuntimeOperationPlan; scope: OperationScope };

/** Lexical cwd relative to the operation entry directory, not remote realpath evidence. */
export type CommandDirectory = { state: 'known'; changes: string[] } | { state: 'unknown' };

export interface CommandContext {
  cwd: CommandDirectory;
  /** Requested identity is not evidence of successful authentication. */
  identity: { state: 'inherited' } | { state: 'requested'; user?: string; group?: string } | { state: 'unknown' };
  namespace: 'inherited' | 'unknown';
  unknownReasons: string[];
}

export interface CommandPathEffect {
  kind: 'read' | 'write';
  path: string;
  directory: CommandDirectory;
  /** Directory traversal/extraction may affect descendants, not only the operand. */
  recursive?: boolean;
}

export interface GitCommandSemantics {
  subcommand?: string;
  args: string[];
  directory: CommandDirectory;
  paths: CommandPathEffect[];
}

export interface TarCommandSemantics {
  mode?: 'create' | 'list' | 'extract';
  paths: CommandPathEffect[];
}

export interface CommandSemantics {
  /** Coverage of supported argv semantics, not proof of all runtime effects or remote path identity. */
  coverage: 'complete' | 'partial';
  unknownReasons: string[];
  git?: GitCommandSemantics;
  tar?: TarCommandSemantics;
}

export interface CommandCall {
  name: string;
  args: string[];
  dynamic: boolean;
  redirects: boolean;
  context?: CommandContext;
  semantics?: CommandSemantics;
  /** Range in raw source, or in the separately labelled embedded shell source. */
  source?: { start: number; end: number; depth: number };
}

export interface CommandAnalysis {
  calls: CommandCall[];
  /** Literal foreground commands in shell evaluation order; absent for opaque syntax. */
  steps?: Array<{ call: CommandCall; condition: 'always' | 'success' | 'failure' }>;
  redirectTargets: string[];
  /** Per-redirection shell context; wrapper cwd does not affect shell redirection. */
  redirectEffects?: Array<{ target: string; context: CommandContext }>;
  /** New analyzers attach scoped contexts; absent for legacy synthetic analysis. */
  scopedContexts?: boolean;
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
  impact?: 'ordinary' | 'high' | 'unknown';
}

export interface SafetySettings {
  mode: ReviewMode;
  revision: number;
  conversationRevision?: number;
  reviewerRevision?: number;
}

export interface OperationResult {
  operationId: string;
  status: 'succeeded' | 'failed' | 'unknown' | 'handed-over';
  exitCode?: number;
  authentication?: 'succeeded' | 'required' | 'failed';
  authenticationAttempts?: number;
  privilege?: import('./privilege.js').PrivilegeFeedback;
  failureKind?: 'authentication-required' | 'permission-denied' | 'authentication-failed' | 'unsupported' | 'user-action-required' | 'unresolved-prior-operation' | 'conflict' | 'unknown';
  effects?: 'none' | 'possible';
  stdoutTail: string;
  /** Redacted observation counts; not evidence of process exit or durable log retention. */
  outputCapture?: { totalChars: number; tailChars: number; truncated: boolean };
  logRef?: string;
  cwd?: string;
  /** Authentication or an unsupported interaction requires an explicit user decision. */
  requiresUserAction?: boolean;
  fileTransaction?: import('./remote-runtime.js').FileTransactionRecord;
  /** Runtime-only evidence that a handed-over PTY command actually left the foreground. */
  remoteCompletion?: Promise<'exited' | 'unknown'>;
}

export interface ApprovalRequest {
  id: string;
  operation: ProposedOperation;
  fingerprint: string;
  ruleId: string;
  reason: string;
  impact?: SafetyDecision['impact'];
  targets?: string[];
  scriptSha256?: string;
  expiresAt: number;
  filePreview?: import('./remote-runtime.js').FileApprovalPreview;
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
  allowPasswordCache?: boolean;
}
