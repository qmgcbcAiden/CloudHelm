import type { ApprovalRequest, CommandAnalysis, InputRequest, OperationResult, ProposedOperation, SafetyDecision } from './model.js';

export interface CommandAnalyzer {
  analyze(command: string): Promise<CommandAnalysis>;
}

export interface RiskEvaluator {
  evaluate(operation: ProposedOperation, analysis: CommandAnalysis | undefined): Promise<'allow' | 'review' | 'deny' | 'error'>;
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

export interface RawTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onData(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
}
