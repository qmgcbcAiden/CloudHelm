import { describe, expect, it, vi } from 'vitest';
import type { ProposedOperation } from '@cloudhelm/core';
import { SafetyGate } from './safety-gate.js';

const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'docker compose up -d', scope: {
  taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: 'pty', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy service'
} };

function setup() {
  let generation = 1;
  let approve!: (allowed: boolean) => void;
  const requestApproval = vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; }));
  const execute = vi.fn().mockResolvedValue({ operationId: 'op', status: 'succeeded', exitCode: 0, stdoutTail: '' });
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'docker', args: ['compose', 'up', '-d'], dynamic: false, redirects: false }],
      redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, hasError: false }) },
    evaluator: { evaluate: async () => 'error' }, approvals: { requestApproval }, executor: { execute },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => generation, isAgentOwner: () => true },
    settings: () => ({ mode: 'ai-review', revision: 1 })
  });
  return { gate, requestApproval, execute, approve: (allowed: boolean) => approve(allowed), changeGeneration: () => { generation++; } };
}

describe('SafetyGate pre-commit authorization', () => {
  it('asks a human when the configured AI reviewer fails', async () => {
    const fixture = setup();
    const pending = fixture.gate.execute(operation);
    await vi.waitFor(() => expect(fixture.requestApproval).toHaveBeenCalledOnce());
    fixture.approve(true);
    expect((await pending).result?.status).toBe('succeeded');
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it('invalidates approval after terminal control changes', async () => {
    const fixture = setup();
    const pending = fixture.gate.execute(operation);
    await vi.waitFor(() => expect(fixture.requestApproval).toHaveBeenCalledOnce());
    fixture.changeGeneration();
    fixture.approve(true);
    expect((await pending).decision.ruleId).toBe('authorization-expired');
    expect(fixture.execute).not.toHaveBeenCalled();
  });
});

it('does not execute if ownership changes while the allow decision is persisted', async () => {
  let generation = 1;
  const execute = vi.fn();
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'pwd', args: [], dynamic: false, redirects: false }], redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, hasError: false }) },
    evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => true }, executor: { execute },
    audit: { proposed: async () => {}, decided: async (_id, decision) => { if (decision.verdict === 'allow') generation++; }, completed: async () => {} },
    lease: { currentGeneration: () => generation, isAgentOwner: () => true }, settings: () => ({ mode: 'permissive', revision: 1 })
  });
  const result = await gate.execute({ ...operation, command: 'pwd' });
  expect(result.decision.ruleId).toBe('authorization-expired');
  expect(execute).not.toHaveBeenCalled();
});

it.each([true, false])('mints the read-only executor capability only from strict parsed queries (%s)', async (query) => {
  const execute = vi.fn().mockResolvedValue({ operationId: 'op', status: 'succeeded', stdoutTail: '' });
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: query ? 'pwd' : 'mkdir', args: query ? [] : ['cache'], dynamic: false, redirects: false }], redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, hasError: false }) },
    evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => true }, executor: { execute },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'permissive', revision: 1 })
  });
  await gate.execute({ ...operation, command: query ? 'pwd' : 'mkdir cache' });
  expect(execute.mock.calls[0]?.[3]).toMatchObject({ readOnly: query, isAuthorized: expect.any(Function) });
});

it('fails closed if parser loading throws', async () => {
  const execute = vi.fn();
  const gate = new SafetyGate({
    analyzer: { analyze: async () => { throw new Error('WASM unavailable'); } }, evaluator: { evaluate: async () => 'allow' },
    approvals: { requestApproval: async () => true }, executor: { execute },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'permissive', revision: 1 })
  });
  expect((await gate.execute(operation)).decision.ruleId).toBe('analyzer-unavailable');
  expect(execute).not.toHaveBeenCalled();
});
