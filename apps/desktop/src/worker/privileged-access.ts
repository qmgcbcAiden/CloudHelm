import type { SafetyGate } from '@cloudhelm/application';
import type { OperationScope, PrivilegeMethod, ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';

export interface PrivilegedTaskAccess {
  request(host: RuntimeHost, command: string, cwd: string, reason: string, goal: string,
    gate: SafetyGate, signal?: AbortSignal, intent?: OperationScope['intent'], method?: PrivilegeMethod, purpose?: 'execute' | 'recover',
    policy?: Pick<OperationScope, 'conversationRevision' | 'reviewerRevision'>): Promise<
      { sessionId: string; method: 'ssh' | 'su'; runAs: 'root' }
      | { sessionId: string; method: 'sudo'; state: 'prepared'; loginAs: string; targetRunAs: 'root'; identityVerified: false }>;
  prepare?(operation: ProposedOperation): Promise<ProposedOperation>;
  sudoContexts?(): Array<{ sessionId: string; hostId: string; state: 'prepared'; loginAs: string; targetRunAs: 'root' }>;
  terminal(sessionId: string, hostId: string): string;
  scope(terminalId: string): Partial<OperationScope>;
  owns(terminalId: string): boolean;
  confirmed?(): Array<{ sessionId: string; hostId: string; method: 'ssh' | 'su'; runAs: 'root' }>;
  close(): void;
}
