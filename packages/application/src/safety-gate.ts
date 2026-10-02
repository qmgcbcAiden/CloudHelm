import { randomUUID } from 'node:crypto';
import {
  decideSafety, isReadOnlyQuery, operationFingerprint,
  type ApprovalRequester, type CommandAnalysis, type CommandAnalyzer, type OperationAudit,
  type OperationExecutor, type OperationResult, type ProposedOperation, type RiskEvaluator,
  type SafetyDecision, type SafetySettings, type TerminalLease
} from '@cloudhelm/core';

export interface GateOutcome {
  decision: SafetyDecision;
  result?: OperationResult;
}

export interface SafetyGateDependencies {
  analyzer: CommandAnalyzer;
  evaluator: RiskEvaluator;
  approvals: ApprovalRequester;
  executor: OperationExecutor;
  audit: OperationAudit;
  lease: TerminalLease;
  settings(hostId: string): SafetySettings;
}

export class SafetyGate {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: SafetyGateDependencies) {}

  async execute(proposed: ProposedOperation, signal?: AbortSignal): Promise<GateOutcome> {
    if (this.inFlight.has(proposed.id)) throw new Error('Operation is already in progress');
    this.inFlight.add(proposed.id);
    try {
      const operation = structuredClone(proposed);
      const fingerprint = operationFingerprint(operation);
      await this.deps.audit.proposed(operation, fingerprint);

      let analysis: CommandAnalysis | undefined;
      if (operation.kind === 'command') {
        try {
          analysis = await this.deps.analyzer.analyze(operation.command);
        } catch {
          const safety = { verdict: 'error', ruleId: 'analyzer-unavailable', reason: 'Command analyzer is unavailable' } as const;
          await this.deps.audit.decided(operation.id, safety, fingerprint);
          return { decision: safety };
        }
      }

      let safety = decideSafety(operation, this.deps.settings(operation.scope.hostId), analysis);
      if (safety.verdict === 'evaluate') {
        let verdict: Awaited<ReturnType<RiskEvaluator['evaluate']>>;
        try { verdict = await this.deps.evaluator.evaluate(operation, analysis); }
        catch { verdict = 'error'; }
        safety = verdict === 'allow'
          ? { verdict: 'allow', ruleId: 'ai-review-allow', reason: 'Independent AI reviewer allowed this operation' }
          : verdict === 'deny'
            ? { verdict: 'deny', ruleId: 'ai-review-deny', reason: 'Independent AI reviewer rejected this operation' }
            : { verdict: 'ask', ruleId: verdict === 'error' ? 'ai-review-unavailable' : 'ai-review-uncertain', reason: 'Independent review requires human decision' };
      }

      if (safety.verdict === 'ask') {
        if (signal?.aborted) {
          const canceled = { verdict: 'error', ruleId: 'review-canceled', reason: 'Operation was canceled before review' } as const;
          await this.deps.audit.decided(operation.id, canceled, fingerprint);
          return { decision: canceled };
        }
        const request = { id: randomUUID(), operation, fingerprint, reason: safety.reason, expiresAt: Date.now() + 10 * 60_000 };
        const approved = await this.awaitApproval(request, signal);
        safety = approved
          ? { verdict: 'allow', ruleId: 'human-approved', reason: 'User approved this exact operation' }
          : { verdict: 'deny', ruleId: 'human-denied', reason: 'User declined this operation' };
      }

      if (safety.verdict !== 'allow') {
        await this.deps.audit.decided(operation.id, safety, fingerprint);
        return { decision: safety };
      }

      const stillCurrent = () => this.deps.lease.isAgentOwner(operation.scope.terminalId)
        && this.deps.lease.currentGeneration(operation.scope.terminalId) === operation.scope.terminalGeneration
        && this.deps.settings(operation.scope.hostId).revision === operation.scope.policyRevision
        && operationFingerprint(operation) === fingerprint
        && !signal?.aborted;
      if (!stillCurrent()) {
        safety = { verdict: 'error', ruleId: 'authorization-expired', reason: 'Terminal, policy, or operation changed before execution' };
        await this.deps.audit.decided(operation.id, safety, fingerprint);
        return { decision: safety };
      }

      await this.deps.audit.decided(operation.id, safety, fingerprint);
      if (!stillCurrent()) {
        safety = { verdict: 'error', ruleId: 'authorization-expired', reason: 'Authorization changed while recording the decision' };
        await this.deps.audit.decided(operation.id, safety, fingerprint);
        return { decision: safety };
      }
      let result: OperationResult;
      try { result = await this.deps.executor.execute(operation, fingerprint, signal, { readOnly: !!analysis && isReadOnlyQuery(analysis), isAuthorized: stillCurrent }); }
      catch (error) {
        result = { operationId: operation.id, status: 'unknown', stdoutTail: error instanceof Error ? error.message : String(error) };
      }
      await this.deps.audit.completed(result);
      return { decision: safety, result };
    } finally {
      this.inFlight.delete(proposed.id);
    }
  }

  private async awaitApproval(request: Parameters<ApprovalRequester['requestApproval']>[0], signal?: AbortSignal): Promise<boolean> {
    let stop!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canceled = new Promise<boolean>((resolve) => {
      stop = () => { this.deps.approvals.cancelApproval?.(request.id); resolve(false); };
      timer = setTimeout(stop, Math.max(0, request.expiresAt - Date.now()));
      signal?.addEventListener('abort', stop, { once: true });
    });
    try {
      if (signal?.aborted) return false;
      const approved = await Promise.race([this.deps.approvals.requestApproval(structuredClone(request)), canceled]);
      return approved && !signal?.aborted && Date.now() < request.expiresAt;
    } catch { return false; }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      this.deps.approvals.cancelApproval?.(request.id);
    }
  }

}
