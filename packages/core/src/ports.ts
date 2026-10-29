import type { ApprovalRequest, CommandAnalysis, InputRequest, OperationResult, ProposedOperation, SafetyDecision } from './model.js';
import type { CommandExecutionPlan } from './remote-runtime.js';

export interface CommandAnalyzer {
  analyze(command: string): Promise<CommandAnalysis>;
}

export interface ScriptInspector {
  inspect(operation: ProposedOperation & { kind: 'command' }, scriptPath: string): Promise<{ source: string; sha256: string }>;
  verify(operation: ProposedOperation & { kind: 'command' }, scriptPath: string, sha256: string): Promise<boolean>;
}

export interface RiskEvaluator {
  evaluate(operation: ProposedOperation, analysis: CommandAnalysis | undefined,
    context?: { classification: SafetyDecision; inspectedScriptSha256?: string }): Promise<RiskAssessment | RiskAssessment['verdict']>;
}

export interface RiskAssessment {
  verdict: 'allow' | 'review' | 'deny' | 'error';
  reason?: string;
  reviewer?: string;
}

export interface ApprovalRequester {
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  cancelApproval?(requestId: string): void;
}

export interface ExecutionOptions {
  /** Minted only by SafetyGate's deterministic read-only classification. */
  readOnly?: boolean;
  /** Synchronous final authorization check; adapters call it before each new side effect. */
  isAuthorized?: () => boolean;
}

export interface OperationExecutor {
  reconcile?(hostId: string, operationId: string): boolean;
  execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult>;
}

export interface OperationAudit {
  proposed(operation: ProposedOperation, fingerprint: string): Promise<void>;
  classified?(operationId: string, readOnly: boolean): Promise<void>;
  decided(operationId: string, decision: SafetyDecision, fingerprint: string): Promise<void>;
  completed(result: OperationResult): Promise<void>;
}

export interface InputPresenter {
  requestInput(request: InputRequest): Promise<string | null>;
}

export interface TerminalLease {
  currentGeneration(terminalId: string): number;
  isAgentOwner(terminalId: string): boolean;
}

export interface RawTerminalExecutionContext {
  operationId: string;
  sessionId: string;
  generation: number;
  plan?: CommandExecutionPlan;
}

export interface AuthenticationChallenge {
  id: string;
  /** Absent when the challenge has closed. Untrusted text belongs only in the private UI. */
  prompt?: string;
  /** Digest of the exact remote prompt bytes; display sanitization must not merge cache identities. */
  promptSha256?: string;
  mechanism?: 'sudo' | 'su' | 'ssh';
  kind?: 'unknown' | 'password' | 'otp';
  /** Stable identity of one sudo process, distinct from its successive challenges. */
  processId?: string;
}

/** Business processes receive only operation-bound controls, never arbitrary human keystrokes. */
export interface AgentExecutionPort {
  execute(command: string, cwd: string, isAuthorized: () => boolean, context?: RawTerminalExecutionContext): Promise<void>;
  confirmInput?(operationId: string, answer: 'y\n' | 'n\n'): boolean;
  interrupt?(operationId: string): boolean;
  respondToTerminalQuery?(operationId: string, data: string): boolean;
  resize?(cols: number, rows: number): void;
  onExecutionFailure?(listener: (failure: Pick<OperationResult, 'failureKind' | 'effects' | 'privilege'>) => void): void;
  onExit?(listener: (exitCode: number | undefined) => void): void;
  onAuthentication?(listener: (challenge: AuthenticationChallenge) => void): void;
  answerAuthentication?(id: string, answer: string | null): boolean;
}

/** An independent interactive shell, activated only by explicit human input. */
export interface HumanTerminalPort {
  open(): void | Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  respondToTerminalQuery?(data: string): boolean;
}

/** Shared presentation and lifecycle; input authorities are separate capabilities. */
export interface RawTerminal {
  readonly agent?: AgentExecutionPort;
  readonly human?: HumanTerminalPort;
  onCommand?(listener: (event: { phase: 'start' | 'end' | 'unavailable'; command?: string; exitCode?: number }) => void): void;
  onDisplay?(listener: (data: string) => void): void;
  takeOver?(): void;
  close(): void;
  onData(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
}
