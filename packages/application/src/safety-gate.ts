import { randomUUID } from 'node:crypto';
import {
  decideSafety, inspectScriptSafety, isEffectFreeQuery, operationFingerprint, scriptFilePath,
  type ApprovalRequester, type CommandAnalysis, type CommandAnalyzer, type OperationAudit,
  type OperationExecutor, type OperationResult, type ProposedOperation, type RiskEvaluator,
  type SafetyDecision, type SafetySettings, type ScriptInspector, type TerminalLease
} from '@cloudhelm/core';

export interface GateOutcome {
  decision: SafetyDecision;
  /** Attested by this gate from the complete operation, never a caller assertion. */
  readOnly?: boolean;
  result?: OperationResult;
}

export interface SafetyGateDependencies {
  analyzer: CommandAnalyzer;
  scripts?: ScriptInspector;
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

  async execute(proposed: ProposedOperation, signal?: AbortSignal, manualReview = false, filePreview?: import('@cloudhelm/core').FileApprovalPreview): Promise<GateOutcome> {
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
        } catch (error) {
          // Fail closed, but keep the cause: a silent "unavailable" hides broken deployments.
          const cause = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          const safety = { verdict: 'error', ruleId: 'analyzer-unavailable', reason: `Command analyzer is unavailable: ${cause}` } as const;
          await this.deps.audit.decided(operation.id, safety, fingerprint);
          return { decision: safety };
        }
      }
      const readOnly = !!analysis && isEffectFreeQuery(analysis);
      await this.deps.audit.classified?.(operation.id, readOnly);

      let settings: SafetySettings;
      try { settings = this.deps.settings(operation.scope.hostId); }
      catch {
        const unavailable = { verdict: 'error', ruleId: 'policy-unavailable', reason: 'Safety policy is unavailable' } as const;
        await this.deps.audit.decided(operation.id, unavailable, fingerprint);
        return { decision: unavailable };
      }
      let safety = decideSafety(operation, settings, analysis);
      let inspectedScript: { path: string; sha256: string } | undefined;
      if (operation.kind === 'command' && analysis && safety.verdict !== 'deny' && safety.verdict !== 'error' && this.deps.scripts) {
        const path = scriptFilePath(analysis);
        if (path) {
          let inspected: Awaited<ReturnType<ScriptInspector['inspect']>> | undefined;
          try {
            inspected = await this.deps.scripts.inspect(operation, path);
          } catch { /* This file is opaque; the selected mode handles it below. */ }
          if (inspected) {
            inspectedScript = { path, sha256: inspected.sha256 };
            let scriptAnalysis: CommandAnalysis;
            try { scriptAnalysis = await this.deps.analyzer.analyze(inspected.source); }
            catch {
              const unavailable = { verdict: 'error', ruleId: 'analyzer-unavailable',
                reason: 'Inspected script could not be parsed; operation was not executed' } as const;
              await this.deps.audit.decided(operation.id, unavailable, fingerprint);
              return { decision: unavailable };
            }
            const result = inspectScriptSafety(operation, inspected.source, scriptAnalysis, settings);
            safety = result;
          } else if (settings.mode !== 'permissive') {
            // An unreadable script never downgrades a decision that already carries
            // higher risk (for example a high-impact wrapper command).
            const fallback = settings.mode === 'ai-review'
              ? { verdict: 'evaluate' as const, ruleId: 'script-uninspectable',
                reason: 'Script could not be read safely before execution', impact: 'unknown' as const }
              : { verdict: 'ask' as const, ruleId: 'script-uninspectable',
                reason: 'Script could not be read safely before execution', impact: 'unknown' as const };
            safety = safety.impact === 'high' || safety.verdict === 'evaluate' ? safety : fallback;
          }
        }
      }
      if (manualReview && safety.verdict !== 'deny' && safety.verdict !== 'error') safety = {
        verdict: 'ask', ruleId: 'ai-denial-manual-review', reason: 'User requested a one-time review of this exact denied operation'
      };
      if (safety.verdict === 'evaluate') {
        let assessment: Awaited<ReturnType<RiskEvaluator['evaluate']>>;
        try { assessment = await this.deps.evaluator.evaluate(operation, analysis, {
            classification: safety, inspectedScriptSha256: inspectedScript?.sha256
          }); }
        catch { assessment = { verdict: 'error', reason: '审核模型调用失败' }; }
        const result = typeof assessment === 'string' ? { verdict: assessment } : assessment;
        const detail = result.reason ? `：${result.reason}` : result.verdict === 'deny' ? '（审核模型未提供具体理由）' : '';
        safety = result.verdict === 'allow'
          ? { verdict: 'allow', ruleId: 'ai-review-allow', reason: `独立审核已放行${detail}` }
          : result.verdict === 'deny'
            ? { verdict: 'deny', ruleId: 'ai-review-deny', reason: `独立审核拒绝该操作${detail}` }
            : { verdict: 'ask', ruleId: result.verdict === 'error' ? 'ai-review-unavailable' : 'ai-review-uncertain',
              reason: `独立审核需要人工判断${detail}` };
      }

      const stillCurrent = () => {
        try {
          const current = this.deps.settings(operation.scope.hostId);
          return this.deps.lease.isAgentOwner(operation.scope.terminalId)
            && this.deps.lease.currentGeneration(operation.scope.terminalId) === operation.scope.terminalGeneration
            && current.revision === operation.scope.policyRevision
            && (operation.scope.conversationRevision === undefined || current.conversationRevision === operation.scope.conversationRevision)
            && (operation.scope.reviewerRevision === undefined || current.reviewerRevision === operation.scope.reviewerRevision)
            && operationFingerprint(operation) === fingerprint && !signal?.aborted;
        } catch { return false; }
      };
      if (safety.verdict === 'ask') {
        if (signal?.aborted) {
          const canceled = { verdict: 'error', ruleId: 'review-canceled', reason: 'Operation was canceled before review' } as const;
          await this.deps.audit.decided(operation.id, canceled, fingerprint);
          return { decision: canceled };
        }
        const request = { id: randomUUID(), operation, filePreview, fingerprint, ruleId: safety.ruleId, reason: safety.reason,
          impact: safety.impact,
          targets: operation.kind === 'command' ? [...new Set([
            ...(analysis?.redirectTargets ?? []),
            ...(analysis?.calls.flatMap((call) => call.args.filter((arg) => /^(?:\/|\.\.?\/)/u.test(arg))) ?? [])
          ])].slice(0, 8) : [operation.kind === 'runtime' ? operation.runtime.directory : operation.kind === 'upload' ? operation.remotePath : operation.path],
          scriptSha256: inspectedScript?.sha256, expiresAt: Date.now() + 10 * 60_000 };
        const approval = stillCurrent() ? await this.awaitApproval(request, signal) : 'stale';
        safety = !stillCurrent() || approval === 'stale'
          ? { verdict: 'error', ruleId: 'authorization-expired', reason: 'Terminal, policy, or operation changed during review' }
          : approval === 'approved' ? { verdict: 'allow', ruleId: 'human-approved', reason: 'User approved this exact operation' }
            : approval === 'denied' ? { verdict: 'deny', ruleId: 'human-denied', reason: 'User declined this operation; it was not executed' }
              : { verdict: 'error', ruleId: approval === 'expired' ? 'approval-expired' : approval === 'canceled' ? 'review-canceled' : 'approval-unavailable',
                reason: 'Approval did not complete; operation was not executed' };
      }

      if (safety.verdict !== 'allow') {
        await this.deps.audit.decided(operation.id, safety, fingerprint);
        return { decision: safety };
      }

      if (!stillCurrent()) {
        safety = { verdict: 'error', ruleId: 'authorization-expired', reason: 'Terminal, policy, or operation changed before execution' };
        await this.deps.audit.decided(operation.id, safety, fingerprint);
        return { decision: safety };
      }
      if (inspectedScript && operation.kind === 'command') {
        let unchanged = false;
        try { unchanged = await this.deps.scripts!.verify(operation, inspectedScript.path, inspectedScript.sha256); } catch { /* deny below */ }
        if (!unchanged || !stillCurrent()) {
          safety = { verdict: 'error', ruleId: 'script-changed', reason: 'Inspected script changed or could not be rechecked before execution' };
          await this.deps.audit.decided(operation.id, safety, fingerprint);
          return { decision: safety };
        }
      }

      await this.deps.audit.decided(operation.id, safety, fingerprint);
      if (!stillCurrent()) {
        safety = { verdict: 'error', ruleId: 'authorization-expired', reason: 'Authorization changed while recording the decision' };
        await this.deps.audit.decided(operation.id, safety, fingerprint);
        return { decision: safety };
      }
      let result: OperationResult;
      try { result = await this.deps.executor.execute(operation, fingerprint, signal, { readOnly, isAuthorized: stillCurrent }); }
      catch (error) {
        result = { operationId: operation.id, status: 'unknown', stdoutTail: error instanceof Error ? error.message : String(error) };
      }
      // Query semantics establish absence of business mutation, not process exit.
      // Keep unknown/handed-over outcomes and all authentication/control metadata.
      if (readOnly && ['succeeded', 'failed'].includes(result.status)
        && Number.isInteger(result.exitCode) && result.exitCode! >= 0) result = { ...result, effects: 'none' };
      await this.deps.audit.completed(result);
      return { decision: safety, readOnly, result };
    } finally {
      this.inFlight.delete(proposed.id);
    }
  }

  private async awaitApproval(request: Parameters<ApprovalRequester['requestApproval']>[0], signal?: AbortSignal): Promise<'approved' | 'denied' | 'expired' | 'canceled' | 'unavailable'> {
    let stop!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canceled = new Promise<'expired' | 'canceled'>((resolve) => {
      stop = () => { this.deps.approvals.cancelApproval?.(request.id); resolve('canceled'); };
      timer = setTimeout(() => { this.deps.approvals.cancelApproval?.(request.id); resolve('expired'); }, Math.max(0, request.expiresAt - Date.now()));
      signal?.addEventListener('abort', stop, { once: true });
    });
    try {
      if (signal?.aborted) return 'canceled';
      const reply = this.deps.approvals.requestApproval(structuredClone(request))
        .then((approved): 'approved' | 'denied' => approved ? 'approved' : 'denied');
      const result = await Promise.race([reply, canceled]);
      return signal?.aborted ? 'canceled' : Date.now() >= request.expiresAt ? 'expired' : result;
    } catch { return 'unavailable'; }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      this.deps.approvals.cancelApproval?.(request.id);
    }
  }

}
