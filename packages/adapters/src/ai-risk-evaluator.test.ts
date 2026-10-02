import { describe, expect, it, vi } from 'vitest';
import type { ProposedOperation } from '@cloudhelm/core';
import { AiRiskEvaluator, type ReviewClient, type ReviewProfile } from './ai-risk-evaluator.js';

const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'docker compose up -d', scope: {
  taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: 'pty', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy service'
} };

function setup(profile: ReviewProfile): { evaluator: AiRiskEvaluator; jev: ReturnType<typeof vi.fn>; ordinary: ReturnType<typeof vi.fn> } {
  const jev = vi.fn().mockResolvedValue('allow');
  const ordinary = vi.fn().mockResolvedValue('allow');
  const client: ReviewClient = { jev, ordinary };
  return { evaluator: new AiRiskEvaluator(() => profile, client), jev, ordinary };
}

describe('paid Jev and ordinary model review selection', () => {
  it('uses ordinary LLM independently when no Jev key is configured', async () => {
    const { evaluator, jev, ordinary } = setup({ provider: 'anthropic', modelId: 'model', apiKey: 'main-key' });
    expect(await evaluator.evaluate(operation, undefined)).toBe('allow');
    expect(ordinary).toHaveBeenCalledOnce();
    expect(jev).not.toHaveBeenCalled();
  });

  it('uses Jev when configured and never falls back after its failure', async () => {
    const { evaluator, jev, ordinary } = setup({ provider: 'anthropic', modelId: 'model', apiKey: 'main-key', jevKey: 'jev-key' });
    jev.mockRejectedValue(new Error('gateway unavailable'));
    expect(await evaluator.evaluate(operation, undefined)).toBe('error');
    expect(ordinary).not.toHaveBeenCalled();
  });
});
