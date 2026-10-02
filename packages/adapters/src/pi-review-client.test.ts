import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProposedOperation } from '@cloudhelm/core';
import { AiRiskEvaluator, PiReviewClient } from './ai-risk-evaluator.js';

const catalog = vi.hoisted(() => ({ getModelOfType: vi.fn(() => ({})), getModel: vi.fn(() => ({})), classify: vi.fn(), completeSimple: vi.fn() }));
vi.mock('@earendil-works/pi-ai/providers/all', () => ({ builtinModels: () => catalog }));
vi.mock('./model-catalog.js', () => ({ createModelCatalog: () => catalog }));
afterEach(() => vi.restoreAllMocks());

const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'docker compose up -d', scope: {
  taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: 'pty', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy service'
} };

describe('review request deadlines', () => {
  it.each(['jev', 'ordinary'] as const)('passes the 30 second abort signal to %s and fails closed on timeout', async (kind) => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const method = kind === 'jev' ? catalog.classify : catalog.completeSimple;
    method.mockImplementation((_model: unknown, _input: unknown, options: { signal: AbortSignal }) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve({ stopReason: 'aborted' }), { once: true });
    }));
    const evaluator = new AiRiskEvaluator(() => ({ provider: 'openai', modelId: 'test', apiKey: 'test-only', jevKey: kind === 'jev' ? 'test-only' : undefined }), new PiReviewClient());
    const pending = evaluator.evaluate(operation, undefined);
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(method.mock.calls.at(-1)?.[2].signal).toBe(controller.signal);
    controller.abort();
    expect(await pending).toBe('error');
  });
});
