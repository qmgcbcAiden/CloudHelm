import type { SafetyDecision } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';

export function applyOperationDecision(view: OperationView, decision: SafetyDecision, consecutiveAiDenials: number): void {
  view.status = decision.verdict === 'allow' ? 'running' : 'denied';
  view.reason = decision.reason; view.ruleId = decision.ruleId;
  view.manualReviewAvailable = decision.ruleId === 'ai-review-deny' && consecutiveAiDenials + 1 < 3;
}
