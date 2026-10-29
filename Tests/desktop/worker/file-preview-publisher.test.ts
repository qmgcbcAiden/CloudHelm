import { expect, it, vi } from 'vitest';
import { SafetyGate } from '@cloudhelm/application';
import type { ApprovalRequest, FileApprovalPreview, ProposedOperation } from '@cloudhelm/core';
import { FilePreviewPublisher } from '../../../apps/desktop/src/worker/file-preview-publisher.js';
import { approvalView } from '../../../apps/desktop/src/worker/approval-view.js';

it.each(['ordinary-allow', 'ai-review-allow', 'human-ask'] as const)('publishes full human-only content for %s without adding it to audit/model input', async (routing) => {
  const target = routing === 'ordinary-allow' ? '/srv/config' : '/etc/systemd/system/app.service';
  const preview: FileApprovalPreview = { path: target, before: 'private old source', after: 'new', encoding: 'utf8', metadata: 'preserve' };
  const operation: ProposedOperation = { id: 'operation', kind: 'write-file', path: target, content: 'new', scope: {
    taskId: 'task', hostId: 'host', cwd: '/srv', loginAs: 'user', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
    policyRevision: 1, protectedPaths: [], allowedWorkingRoots: ['/srv'], goal: 'update configuration' },
    filePlan: { version: 1, transactionId: 'transaction', before: { path: target, exists: false,
      parent: { device: '1', inode: '2', size: 0, mtimeNs: '0', ctimeNs: '0' } }, contentSha256: 'a'.repeat(64), contentSize: 3,
      metadataPolicy: 'preserve-or-refuse', runtime: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'b'.repeat(64), size: 1 } } };
  const order: string[] = []; const privatePublish = vi.fn(() => { order.push('private-preview'); });
  const publisher = new FilePreviewPublisher(privatePublish);
  const audit: unknown[] = []; const evaluator = { evaluate: vi.fn(async () => ({ verdict: 'allow' as const })) };
  const approvals = { requestApproval: vi.fn(async (_request: ApprovalRequest) => true) };
  const gate = new SafetyGate({ analyzer: { analyze: vi.fn() }, evaluator, approvals,
    executor: { execute: async () => { order.push('execute'); return { operationId: 'operation', status: 'succeeded', effects: 'possible', stdoutTail: '' }; } },
    lease: { isAgentOwner: () => true, currentGeneration: () => 1 }, settings: () => ({ mode: routing === 'ai-review-allow' ? 'ai-review' : 'ask', revision: 1 }),
    audit: { proposed: async (op) => { audit.push(op); order.push('operation'); publisher.proposed(op); },
      decided: async (_id, decision) => { audit.push(decision); }, completed: async (result) => { audit.push(result); } } });
  expect((await publisher.execute(gate, operation, undefined, false, preview)).result?.status).toBe('succeeded');
  expect(order).toEqual(['operation', 'private-preview', 'execute']);
  expect(privatePublish).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'operation', taskId: 'task', hostId: 'host', transactionId: 'transaction', preview }));
  expect(JSON.stringify(audit)).not.toContain('private old source'); expect(JSON.stringify(evaluator.evaluate.mock.calls)).not.toContain('private old source');
  expect(approvals.requestApproval).toHaveBeenCalledTimes(routing === 'human-ask' ? 1 : 0);
  if (routing === 'human-ask') {
    const request = approvals.requestApproval.mock.calls[0]?.[0];
    const view = approvalView(request!);
    expect(view.filePreviewOperationId).toBe('operation'); expect(JSON.stringify(view)).not.toContain('private old source');
  }
  publisher.proposed(operation); expect(privatePublish).toHaveBeenCalledOnce();
});
