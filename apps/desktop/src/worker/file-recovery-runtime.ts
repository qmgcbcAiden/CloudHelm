import path from 'node:path';
import { SafetyGate, recoverFileTransaction, type FileRemotePort, type TerminalManager, type ManagedFileOperation } from '@cloudhelm/application';
import { BashAnalyzer, SshCommandTerminal, type SshTransport } from '@cloudhelm/adapters';
import type { FileTransactionJournal, FileTransactionRecord, OperationExecutor } from '@cloudhelm/core';
import type { ApprovalView, FileRecoveryView, OperationView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { NativeRuntimePreparation } from './native-runtime-preparation.js';
import type { PrivilegedRuntime } from './privileged-runtime.js';
import { operationPreview } from './operation-preview.js';

interface Dependencies {
  terminal: TerminalManager; ssh: SshTransport; native: NativeRuntimePreparation; privileged: PrivilegedRuntime;
  executor: OperationExecutor; journal: FileTransactionJournal;
  files(operation: ManagedFileOperation): { remote: FileRemotePort };
  host(id: string): RuntimeHost | undefined;
  approval(value: ApprovalView): Promise<boolean>; cancelApproval(id: string): void;
  operation(value: OperationView): void;
}
/** A user-triggered bounded recovery path. Never runs model output or replays apply. */
export async function recoverManagedFile(record: FileTransactionRecord, deps: Dependencies): Promise<{ view: FileRecoveryView; resolved: boolean }> {
  const host = deps.host(record.hostId);
  if (!host || !deps.ssh.isConnected(record.hostId)) throw new Error('请先重新连接原主机，再核验文件事务');
  if (deps.terminal.pendingOperations(record.taskId).length) throw new Error('原任务仍有远端操作运行，请先等待退出');
  const signal = AbortSignal.timeout(10 * 60_000);
  const views = new Map<string, OperationView>();
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), executor: deps.executor, lease: deps.terminal,
    evaluator: { evaluate: async () => ({ verdict: 'review', reason: '恢复使用固定原生组件；请确认声明的组件路径和身份。' }) },
    settings: (id) => { const current = deps.host(id); if (!current) throw new Error('Host removed');
      return { mode: current.defaultMode, revision: current.policyRevision }; },
    approvals: { requestApproval: (request) => deps.approval({ id: request.id, taskId: record.taskId,
      operationId: request.operation.id, hostId: record.hostId, fingerprint: request.fingerprint,
      title: '核验文件事务前准备运行组件', explanation: request.reason, preview: operationPreview(request.operation),
      account: request.operation.scope.runAs, cwd: request.operation.scope.cwd, targets: request.targets, expiresAt: request.expiresAt }),
      cancelApproval: (id) => deps.cancelApproval(id) },
    audit: {
      proposed: async (operation) => { const view: OperationView = { id: operation.id, taskId: record.taskId, hostId: record.hostId,
        kind: operation.kind, status: 'proposed', preview: operationPreview(operation), loginAs: operation.scope.loginAs,
        runAs: operation.scope.runAs, logRef: operation.scope.terminalId, createdAt: Date.now() }; views.set(operation.id, view); deps.operation(view); },
      decided: async (id, decision) => { const view = views.get(id); if (view) deps.operation({ ...view, status: decision.verdict === 'allow' ? 'running' : 'denied', reason: decision.reason }); },
      completed: async (result) => { const view = views.get(result.operationId); if (view) deps.operation({ ...view,
        status: result.status === 'succeeded' ? 'succeeded' : result.status === 'failed' ? 'failed' : 'unknown', effects: result.effects,
        exitCode: result.exitCode, reason: result.stdoutTail, completedAt: Date.now(), exitObserved: result.exitCode !== undefined }); }
    }
  });
  let terminalId: string; let sessionId: string | undefined;
  if (record.loginAs === host.username && record.runAs === host.username) {
    terminalId = deps.terminal.open(host.id, new SshCommandTerminal(deps.ssh, host.id), record.taskId, path.posix.dirname(record.plan.before.path));
  } else if (record.loginAs === 'root' && record.runAs === 'root') {
    const access = deps.privileged.forTask(record.taskId);
    const session = await access.request(host, '读取原文件事务提交凭据', path.posix.dirname(record.plan.before.path),
      '使用原执行身份核验文件事务，不重新提交文件', '核验原文件事务', gate, signal, undefined, 'ssh', 'recover');
    if (session.method !== 'ssh') throw new Error('恢复需要显式 root SSH 身份');
    sessionId = session.sessionId; terminalId = access.terminal(sessionId, host.id);
  } else throw new Error('原文件执行身份与当前登录账户不符，请使用原账户重新连接');
  try {
    const scope = { taskId: record.taskId, hostId: host.id, terminalId, terminalGeneration: deps.terminal.currentGeneration(terminalId),
      cwd: path.posix.dirname(record.plan.before.path), loginAs: record.loginAs, runAs: record.runAs, sessionId,
      connectionGeneration: sessionId ? 1 : deps.ssh.connectionGeneration(host.id), policyRevision: host.policyRevision,
      allowedWorkingRoots: [], protectedPaths: [...host.protectedPaths], protectedReadPaths: [...(host.protectedReadPaths ?? host.protectedPaths)],
      protectedWritePaths: [...(host.protectedWritePaths ?? host.protectedPaths)], goal: '只读核验原文件事务及提交凭据' };
    const operation: ManagedFileOperation = record.plan.contentSha256 === undefined
      ? { id: record.operationId, kind: 'delete-path', path: record.plan.before.path, scope, filePlan: record.plan }
      : { id: record.operationId, kind: 'write-file', path: record.plan.before.path, content: '', scope, filePlan: record.plan };
    const protectedRead = scope.protectedReadPaths.some((root) => operation.filePlan!.before.path === root
      || operation.filePlan!.before.path.startsWith(`${root.replace(/\/$/u, '')}/`));
    if (protectedRead) throw new Error('当前读取保护策略禁止核验该文件');
    await deps.native.ensure(operation, gate, deps.privileged.fileTransport(operation), host.runtimeDirectory, signal, 'recover');
    const result = await recoverFileTransaction(record, operation, deps.files(operation).remote, deps.journal, signal);
    return { view: result.view, resolved: result.resolved };
  } finally {
    try { if (deps.terminal.hostOf(terminalId)) deps.terminal.close(terminalId); }
    finally { await deps.native.abandonSession(record.taskId, sessionId ?? terminalId); }
  }
}
