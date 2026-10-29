import { expect, it, vi } from 'vitest';
import { operationFingerprint, type ProposedOperation, type RawTerminal } from '@cloudhelm/core';
import { TerminalManager } from '@cloudhelm/application';

function operation(terminalId: string): ProposedOperation {
  return { id: 'operation', kind: 'command', command: 'echo fixture', scope: { taskId: 'task', hostId: 'host',
    cwd: '/srv', runAs: 'deploy', terminalId, terminalGeneration: 1, policyRevision: 1,
    allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'fixture' } };
}

it.each([false, true])('refuses execution without an Agent capability and never falls back to legacy input (human=%s)', async (human) => {
  const legacyExecute = vi.fn(); const legacyWrite = vi.fn(); const humanWrite = vi.fn();
  const channel = { close() {}, onData() {}, onClose() {}, execute: legacyExecute, write: legacyWrite,
    ...(human ? { human: { open() {}, write: humanWrite, resize() {} } } : {}) };
  const manager = new TerminalManager({ data() {}, state() {} });
  const proposed = operation(manager.open('host', channel, 'task'));
  await expect(manager.execute(proposed, operationFingerprint(proposed))).rejects.toThrow('Agent execution capability');
  expect(legacyExecute).not.toHaveBeenCalled(); expect(legacyWrite).not.toHaveBeenCalled(); expect(humanWrite).not.toHaveBeenCalled();
  expect(manager.pendingOperations('task')).toEqual([]);
});

it('routes confirmation, interrupt, and terminal queries only to the bound Agent operation, then human input to the human port', async () => {
  let exited: (code: number) => void = () => {};
  const humanWrite = vi.fn(); const humanQuery = vi.fn(() => true);
  const confirmInput = vi.fn(() => true); const interrupt = vi.fn(() => true); const agentQuery = vi.fn(() => true);
  const channel: RawTerminal = { close() {}, onData() {}, onClose() {},
    agent: { execute: async () => {}, confirmInput, interrupt, respondToTerminalQuery: agentQuery, onExit: (callback) => { exited = callback; } },
    human: { open() {}, write: humanWrite, resize() {}, respondToTerminalQuery: humanQuery } };
  const manager = new TerminalManager({ data() {}, state() {} });
  const terminalId = manager.open('host', channel, 'task'); const proposed = operation(terminalId);
  const pending = manager.execute(proposed, operationFingerprint(proposed));
  expect(() => manager.input(terminalId, 'echo bypass\n', true)).toThrow('先停止');
  expect(manager.confirmInput(terminalId, 'foreign', 'y\n')).toBe(false);
  expect(confirmInput).not.toHaveBeenCalled();
  expect(manager.confirmInput(terminalId, proposed.id, 'y\n')).toBe(true);
  expect(confirmInput).toHaveBeenCalledExactlyOnceWith('operation', 'y\n');
  manager.input(terminalId, '\u001b[1;1R', false); manager.input(terminalId, 'echo bypass\n', false);
  expect(agentQuery).toHaveBeenCalledExactlyOnceWith('operation', '\u001b[1;1R');
  manager.stopCommand(terminalId); expect(interrupt).toHaveBeenCalledExactlyOnceWith('operation');
  expect(humanWrite).not.toHaveBeenCalled(); expect(humanQuery).not.toHaveBeenCalled();
  expect(manager.confirmInput(terminalId, proposed.id, 'n\n')).toBe(false);
  exited(0); await pending;
  manager.takeOver(terminalId); manager.input(terminalId, 'pwd\n', true); manager.input(terminalId, '\u001b[1;1R', false);
  expect(humanWrite).toHaveBeenCalledExactlyOnceWith('pwd\n');
  expect(humanQuery).toHaveBeenCalledExactlyOnceWith('\u001b[1;1R');
  expect(agentQuery).toHaveBeenCalledOnce(); expect(confirmInput).toHaveBeenCalledOnce(); expect(interrupt).toHaveBeenCalledOnce();
});
