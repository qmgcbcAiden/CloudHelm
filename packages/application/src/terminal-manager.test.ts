import { describe, expect, it } from 'vitest';
import type { ProposedOperation, RawTerminal } from '@cloudhelm/core';
import { operationFingerprint } from '@cloudhelm/core';
import { TerminalManager } from './terminal-manager.js';

class FakeTerminal implements RawTerminal {
  writes: string[] = [];
  private data?: (text: string) => void;
  private closed?: () => void;
  write(text: string): void { this.writes.push(text); }
  resize(): void {}
  close(): void { this.closed?.(); }
  onData(listener: (text: string) => void): void { this.data = listener; }
  onClose(listener: () => void): void { this.closed = listener; }
  emit(text: string): void { this.data?.(text); }
}

function operation(id: string, generation: number): ProposedOperation {
  return { id, kind: 'command', command: 'echo hi', scope: {
    taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: 'replace', terminalGeneration: generation,
    policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy'
  } };
}

describe('real PTY ownership', () => {
  it('rejects an approved command after immediate human takeover', async () => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('one', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    manager.input(id, 'pwd\n', true);
    await expect(manager.execute(proposed, operationFingerprint(proposed))).rejects.toThrow('authorization expired');
    expect(channel.writes).toEqual(['pwd\n']);
  });

  it('shows the approved command in the remote PTY and records its marker result', async () => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('one', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const result = manager.execute(proposed, operationFingerprint(proposed));
    expect(channel.writes[0]).toContain('echo hi');
    const marker = /(__CLOUDHELM_DONE_[a-f\d]+__)/u.exec(channel.writes[0] ?? '')?.[1];
    channel.emit(`hi\r\n${marker}:0\r\n`);
    expect((await result).status).toBe('succeeded');
  });

  it('keeps observing the remote marker after human takeover', async () => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('takeover', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const running = manager.execute(proposed, operationFingerprint(proposed));
    const marker = /(__CLOUDHELM_DONE_[a-f\d]+__)/u.exec(channel.writes[0] ?? '')?.[1];
    manager.takeOver(id);
    const handedOver = await running;
    expect(handedOver.status).toBe('handed-over');
    expect(handedOver.remoteCompletion).toBeDefined();
    channel.emit(`${marker}:0\r\n`);
    expect(await handedOver.remoteCompletion).toBe('exited');
  });

  it('invalidates a running Agent operation when its terminal is closed', async () => {
    const channel = new FakeTerminal();
    const states: string[] = [];
    const manager = new TerminalManager({ data() {}, state(_id, owner) { states.push(owner); } });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('closing', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const running = manager.execute(proposed, operationFingerprint(proposed));
    manager.close(id);
    const result = await running;
    expect(result.status).toBe('unknown');
    expect(await result.remoteCompletion).toBe('unknown');
    expect(manager.currentGeneration(id)).toBe(-1);
    expect(states).toEqual(['agent', 'suspended', 'closed']);
  });
});
