import { buildCommandExecutionPlan, commandExecutionIdentities, type CommandAnalysis, type OperationScope, type ProposedOperation } from '@cloudhelm/core';
import type { TerminalManager } from '@cloudhelm/application';
import type { RuntimeHost, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import type { TaskView } from '@cloudhelm/contracts';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import type { TaskIntent } from './task-intent.js';

/** Finalize identities before both replay lookup and SafetyGate audit bind the operation. */
export function bindCommandExecutionPlan(operation: ProposedOperation & { kind: 'command' }, analysis: CommandAnalysis): void {
  const identity = operation.scope.sessionId && operation.scope.runAs === 'root' ? 'root' : operation.scope.loginAs ?? operation.scope.runAs;
  operation.executionPlan = buildCommandExecutionPlan(analysis, identity);
  operation.scope.runAs = commandExecutionIdentities(operation.executionPlan).join(' → ');
}

export function taskOperationScope(task: TaskView, host: RuntimeHost, terminalId: string, cwd: string,
  terminal: TerminalManager, profile: RuntimeProfile, intent: TaskIntent, privileged?: PrivilegedTaskAccess): OperationScope {
  return {
    taskId: task.id, hostId: host.id, cwd, runAs: host.username, loginAs: host.username, ...privileged?.scope(terminalId),
    terminalId, terminalGeneration: terminal.currentGeneration(terminalId), policyRevision: host.policyRevision,
    conversationRevision: task.reviewRevision ?? 1, reviewerRevision: profile.reviewer?.revision ?? 1,
    sudoCachePolicy: host.sudoCachePolicy, allowedWorkingRoots: ['/srv', '/opt', `/home/${host.username}`, '/root'],
    protectedPaths: [...host.protectedPaths], protectedReadPaths: [...(host.protectedReadPaths ?? host.protectedPaths)],
    protectedWritePaths: [...(host.protectedWritePaths ?? host.protectedPaths)], goal: intent.goal(), intent: intent.snapshot()
  };
}
