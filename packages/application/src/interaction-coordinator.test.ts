import { describe, expect, it } from 'vitest';
import type { InputRequest } from '@cloudhelm/core';
import { InteractionCoordinator } from './interaction-coordinator.js';

describe('input request lifecycle', () => {
  it('binds an answer to one operation and rejects it after takeover', async () => {
    let generation = 1;
    let request!: InputRequest;
    const writes: string[] = [];
    const coordinator = new InteractionCoordinator({ currentGeneration: () => generation, isAgentOwner: () => generation === 1 },
      { opened: (value) => { request = value; }, closed() {} });
    const details = { operationId: 'op', taskId: 'task', hostId: 'host', terminalId: 'pty', terminalGeneration: 1,
      connectionGeneration: 1, kind: 'secret' as const, recipient: 'sudo', reason: 'Install package', prompt: 'Password' };
    const result = coordinator.request(details, { isWaiting: () => true, deliver: async (_request, value) => { writes.push(value); return true; } });
    generation++;
    expect(await coordinator.answer(request.id, 'late-secret')).toBe(false);
    expect(await result).toBe('expired');
    expect(writes).toEqual([]);
  });
});
