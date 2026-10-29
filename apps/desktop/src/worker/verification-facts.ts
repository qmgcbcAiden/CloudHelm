import { createHash } from 'node:crypto';
import { operationNeedsVerification, type GoalCheck, type OperationView, type VerificationFacts, type VerificationReport,
  type VerificationReason } from '@cloudhelm/contracts';
import { mergeOperationViews } from './runtime-facts.js';
import { eligibleObservation } from './verification-feedback.js';
import { completeOutput, normalize } from './verification-output.js';
import { automaticRunChecks, executionSummary } from './verification-observations.js';
import { redactOutput } from '@cloudhelm/core';
import { hasJournalCredentials } from './journal-secrets.js';

export { completeOutput, evaluateRunOutput } from './verification-output.js';

/** Compare content read back from the same host/path after the latest write to that path. */
function fileChecks(operations: OperationView[]): GoalCheck[] {
  const latest = new Map<string, { op: OperationView; index: number }>();
  operations.forEach((op, index) => {
    if (op.verificationSource?.kind === 'file-write' && op.status === 'succeeded' && op.exitObserved && op.completedAt !== undefined) latest.set(JSON.stringify([op.hostId, op.verificationSource.path]), { op, index });
  });
  return [...latest.values()].flatMap(({ op, index }) => {
    const source = op.verificationSource!;
    if (source.kind !== 'file-write') return [];
    const observation = operations.slice(index + 1).reverse().find((candidate) => candidate.hostId === op.hostId && candidate.createdAt >= op.completedAt!
      && candidate.verificationSource?.kind === 'file-read' && candidate.verificationSource.path === source.path
      && eligibleObservation({ operation: candidate, index: 0 }));
    if (!observation) return [];
    const output = completeOutput(observation);
    const matches = output !== undefined && createHash('sha256').update(source.textSha256 ? normalize(output) : output).digest('hex') === (source.textSha256 ?? source.sha256);
    return [{ kind: 'file-content' as const, authority: 'deterministic' as const, target: source.path, operationIds: [op.id, observation.id],
      expected: source.textSha256 ? '同一路径读回文本与写入文本一致（CRLF归一化，仅代表该次观察）。' : '同一路径读回字节与本次写入内容 SHA-256 一致（仅代表该次观察）。',
      observed: output === undefined ? '已取得读回记录，但捕获不完整，无法比较。' : matches ? '读回内容与写入内容一致。' : '读回内容与写入内容不一致或读取失败。',
      status: output === undefined ? 'inconclusive' as const : matches && observation.status === 'succeeded' && observation.exitCode === 0 ? 'passed' as const : 'failed' as const }];
  });
}

export function buildVerificationReport(input: {
  roundId: string; revision: number; operations: OperationView[]; all: OperationView[];
  submitted?: VerificationReport; checks?: GoalCheck[];
}): VerificationReport {
  const operations = mergeOperationViews(input.operations).filter((operation) => operation.kind !== 'runtime');
  const all = mergeOperationViews(input.all);
  const execution = executionSummary(operations);
  const goalChecks = [...fileChecks(operations), ...automaticRunChecks(operations, input.checks ?? [], execution.recoveredAttemptIds ?? [])];
  const targets = goalChecks.filter((check) => check.kind !== 'run-completion');
  const runs = goalChecks.filter((check) => check.kind === 'run-completion');
  const riskOperationIds = all.filter((op) => op.reconciliation?.kind === 'risk-accepted'
    && !(op.status === 'succeeded' && op.exitObserved)).map((op) => op.id);
  const unresolvedOperationIds = all.filter(operationNeedsVerification).map((op) => op.id);
  const uncheckedOperationIds = operations.filter((op) => op.status === 'succeeded' && op.readOnly !== true
    && !goalChecks.some((check) => check.authority === 'deterministic' && check.operationIds.includes(op.id) && check.status === 'passed')).map((op) => op.id);
  const facts: VerificationFacts = { roundId: input.roundId, revision: input.revision,
    registration: input.submitted ? 'submitted' : 'automatic',
    ...execution,
    goals: goalChecks.some((check) => check.status === 'failed') ? 'failed' : goalChecks.some((check) => check.status === 'inconclusive') ? 'inconclusive'
      : targets.length ? targets.some((check) => check.authority === 'model') ? 'model-assessed' : 'passed'
      : runs.length ? 'execution-observed' : 'not-checked',
    impact: unresolvedOperationIds.length ? 'unresolved' : riskOperationIds.length ? 'risk-accepted'
      : operations.some((op) => op.readOnly !== true && op.effects !== 'none') ? 'not-assessed' : 'effect-free',
    operations: operations.map((op) => ({ operationId: op.id, hostId: op.hostId, kind: op.kind === 'runtime' ? undefined : op.kind, status: op.status, exitCode: op.exitCode, readOnly: op.readOnly })),
    riskOperationIds, unresolvedOperationIds, uncheckedOperationIds };
  const observations = facts.goals === 'execution-observed' ? '已确认运行并保存输出；尚未比较输出与业务要求。'
    : facts.goals === 'passed' ? '已登记的具体检查通过，影响另列。' : '检查结论与缺失证据见下方具体记录。';
  return { version: 3, summary: input.submitted?.summary ?? `${facts.execution === 'succeeded-after-retry' ? '后续运行已成功，未启动的原尝试仍保留。' : '已自动整理实际执行记录。'}${observations}`,
    access: input.submitted?.access ?? [], recovery: input.submitted?.recovery ?? ['未自动执行恢复；恢复操作仍须单独审核。'],
    changes: input.submitted?.changes?.length ? input.submitted.changes : operations.slice(-32).map((op) =>
      `${op.status === 'succeeded' ? '已完成' : op.status === 'failed' ? '失败尝试（详见操作记录）' : op.status}：${hasJournalCredentials(redactOutput(op.preview)) ? '正文含疑似凭据，未复制到报告。' : redactOutput(op.preview).slice(0, 512)}`)
      .concat(operations.length > 32 ? [`更早的 ${operations.length - 32} 项见全部操作。`] : []),
    evidenceOperationIds: [...new Set(goalChecks.flatMap((check) => check.operationIds))], goalChecks, facts,
    unverifiedChanges: input.submitted?.unverifiedChanges ?? [] };
}

/** Limited to recorded goals, never an assertion of complete business success or no side effects. */
export function verificationReason(report: VerificationReport): VerificationReason | undefined {
  const facts = report.facts!;
  if (facts.goals === 'failed' || facts.execution === 'failed') return 'checks-failed';
  if (facts.goals === 'inconclusive' || facts.unresolvedOperationIds.length) return 'checks-inconclusive';
  if (facts.goals === 'model-assessed') return 'model-assessed';
  if (facts.goals === 'not-checked' || facts.goals === 'execution-observed') return 'goals-not-checked';
  if (facts.riskOperationIds.length) return 'risk-accepted';
  return undefined;
}
