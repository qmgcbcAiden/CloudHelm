import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AppEvent, OperationView, VerificationReport } from '@cloudhelm/contracts';
import { WorkJournal } from './work-journal.js';

const operation = (id: string, status: OperationView['status'] = 'succeeded', taskId = 'conversation-a'): OperationView => ({
  id, taskId, status, hostId: 'host-a', kind: 'command', preview: 'curl --fail http://localhost:8080/health', createdAt: 1
});
const report = (ids = ['verification']): VerificationReport => ({
  summary: '服务已部署并通过健康检查', access: ['http://localhost:8080'], evidenceOperationIds: ids,
  changes: ['启动服务容器'], recovery: ['使用保存的 compose 配置恢复旧版本']
});

function setup(operations: OperationView[], canReconcile = false) {
  const events: AppEvent[] = [];
  const readLog = vi.fn(async () => ({ text: 'service is healthy', nextCursor: 18, more: false }));
  const reconcile = vi.fn(() => canReconcile);
  const reconciled = vi.fn((_operation: OperationView) => {});
  const journal = new WorkJournal('conversation-a', () => operations, (event) => events.push(event), readLog, reconcile, reconciled);
  const call = (name: string, args: unknown) => {
    const tool = journal.tools().find((candidate) => candidate.name === name) as AgentTool;
    return tool.execute(`call-${name}`, args);
  };
  return { journal, events, readLog, call, reconcile, reconciled };
}

describe('verification evidence', () => {
  it.each(['failed', 'denied', 'unknown', 'running', 'proposed', 'approved'] as const)(
    'rejects a %s operation as verification evidence', async (status) => {
      const test = setup([operation('verification', status)]);
      expect((await test.call('submit_verification', report())).isError).toBe(true);
      expect(test.journal.hasReport()).toBe(false);
      expect(test.events).toEqual([]);
    });

  it('rejects missing or empty evidence even if narrative claims success', async () => {
    const test = setup([]);
    expect((await test.call('submit_verification', report(['nonexistent']))).isError).toBe(true);
    expect((await test.call('submit_verification', report([]))).isError).toBe(true);
    expect(test.journal.hasReport()).toBe(false);
  });

  it('does not accept successful evidence owned by a different conversation', async () => {
    const test = setup([operation('foreign-check', 'succeeded', 'conversation-b')]);
    expect((await test.call('submit_verification', report(['foreign-check']))).isError).toBe(true);
    expect(test.events).toEqual([]);
  });

  it.each(['unknown', 'running', 'proposed', 'approved'] as const)(
    'rejects acceptance when another operation still has a %s outcome', async (status) => {
      const test = setup([operation('verification'), operation('pending-operation', status)]);
      expect((await test.call('submit_verification', report())).isError).toBe(true);
      expect(test.journal.hasReport()).toBe(false);
    });

  it('requires meaningful access, change and recovery notes before emitting an acceptance report', async () => {
    const test = setup([operation('verification')]);
    for (const field of ['access', 'changes', 'recovery'] as const) {
      expect((await test.call('submit_verification', { ...report(), [field]: [' '] })).isError).toBe(true);
    }
    expect((await test.call('submit_verification', report())).isError).not.toBe(true);
    expect(test.journal.hasReport()).toBe(true);
    expect(test.events).toEqual([{ type: 'work-report', taskId: 'conversation-a', report: report() }]);
    test.journal.resetReport();
    expect(test.journal.hasReport()).toBe(false);
  });
});

describe('operation log access', () => {
  it('only reads an operation from the current conversation and forwards its page cursor', async () => {
    const test = setup([operation('own'), operation('foreign', 'succeeded', 'conversation-b')]);
    expect((await test.call('read_operation_log', { operationId: 'missing' })).isError).toBe(true);
    expect((await test.call('read_operation_log', { operationId: 'foreign' })).isError).toBe(true);
    expect(test.readLog).not.toHaveBeenCalled();
    const result = await test.call('read_operation_log', { operationId: 'own', cursor: 4096 });
    expect(result.isError).not.toBe(true);
    expect(test.readLog).toHaveBeenCalledExactlyOnceWith('own', 4096);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ text: 'service is healthy', nextCursor: 18, more: false }) }]);
  });
});

describe('visible plans', () => {
  it('rejects duplicate identifiers and empty step titles without changing visible progress', async () => {
    const test = setup([]);
    expect((await test.call('update_plan', { steps: [
      { id: 'inspect', title: '检查服务', status: 'running' }, { id: 'inspect', title: '部署服务', status: 'pending' }
    ] })).isError).toBe(true);
    expect((await test.call('update_plan', { steps: [{ id: 'inspect', title: ' ', status: 'running' }] })).isError).toBe(true);
    expect(test.events).toEqual([]);
  });
});

describe('reconciling unknown remote outcomes', () => {
  const reconcileRequest = (evidenceOperationIds = ['fresh-check']) => ({
    operationId: 'unknown-deployment', evidenceOperationIds, outcome: 'succeeded',
    explanation: '已重新检查容器状态和健康端点，确认上一次部署命令成功完成。'
  });
  const unknownOperation = () => ({ ...operation('unknown-deployment', 'unknown'), createdAt: 20 });
  const freshEvidence = () => ({ ...operation('fresh-check'), createdAt: 30 });

  it.each([
    ['missing', undefined],
    ['older', { ...freshEvidence(), createdAt: 10 }],
    ['same timestamp', { ...freshEvidence(), createdAt: 20 }],
    ['different host', { ...freshEvidence(), hostId: 'host-b' }],
    ['different conversation', { ...freshEvidence(), taskId: 'conversation-b' }],
    ['failed check', { ...freshEvidence(), status: 'failed' as const }]
  ])('rejects %s evidence without clearing an unknown result', async (_label, evidence) => {
    const original = unknownOperation();
    const test = setup([original, ...(evidence ? [evidence] : [])], true);
    expect((await test.call('record_reconciled_result', reconcileRequest())).isError).toBe(true);
    expect(original.status).toBe('unknown');
    expect(test.reconcile).not.toHaveBeenCalled();
    expect(test.reconciled).not.toHaveBeenCalled();
  });

  it('requires nonempty evidence and an actual unknown target in this conversation', async () => {
    const foreignTarget = { ...unknownOperation(), taskId: 'conversation-b' };
    const test = setup([foreignTarget, freshEvidence()], true);
    expect((await test.call('record_reconciled_result', reconcileRequest([]))).isError).toBe(true);
    expect((await test.call('record_reconciled_result', reconcileRequest())).isError).toBe(true);
    expect(test.reconcile).not.toHaveBeenCalled();
    expect(foreignTarget.status).toBe('unknown');
  });

  it('cannot clear a still-running original command despite a newer successful inspection', async () => {
    const original = { ...unknownOperation(), status: 'running' as const };
    const test = setup([original, freshEvidence()], true);
    expect((await test.call('record_reconciled_result', reconcileRequest())).isError).toBe(true);
    expect(original.status).toBe('running');
    expect(test.reconcile).not.toHaveBeenCalled();
    expect(test.reconciled).not.toHaveBeenCalled();
  });

  it('preserves unknown status if the execution coordinator cannot reconcile it', async () => {
    const original = unknownOperation();
    const test = setup([original, freshEvidence()], false);
    expect((await test.call('record_reconciled_result', reconcileRequest())).isError).toBe(true);
    expect(test.reconcile).toHaveBeenCalledExactlyOnceWith(original);
    expect(test.reconciled).not.toHaveBeenCalled();
    expect(original.status).toBe('unknown');
    expect(original.reason).toBeUndefined();
  });

  it.each(['succeeded', 'failed'] as const)('records an observed %s result only after coordinator approval, then synchronously reports it', async (outcome) => {
    const original = unknownOperation();
    const test = setup([original, freshEvidence()], true);
    test.reconciled.mockImplementation((updated) => {
      expect(updated.status).toBe(outcome);
      expect(updated.reason).toContain('fresh-check');
    });
    const result = await test.call('record_reconciled_result', { ...reconcileRequest(), outcome });
    expect(result.isError).not.toBe(true);
    expect(test.reconcile).toHaveBeenCalledExactlyOnceWith(original);
    expect(test.reconciled).toHaveBeenCalledExactlyOnceWith(original);
    expect(original.status).toBe(outcome);
    expect(test.journal.hasReport()).toBe(false);
  });
});
