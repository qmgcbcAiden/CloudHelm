import { beforeEach, describe, expect, it } from 'vitest';
import type { AppSnapshot, TaskView } from '@cloudhelm/contracts';
import { useUi } from './store.js';

function conversation(id: string, hostId: string | null, updatedAt: number): TaskView {
  return { id, goal: id, hostIds: hostId ? [hostId] : [], localScopes: [], status: 'running', modelId: 'test-model', provider: 'test', requestCount: 1, requestLimit: 100, createdAt: updatedAt, updatedAt };
}
function snapshot(): AppSnapshot {
  return { hosts: [], conversations: [conversation('a-old', 'a', 1), conversation('a-new', 'a', 4), conversation('b-chat', 'b', 3), conversation('free', null, 2)],
    terminals: [{ id: 'a-ssh', hostId: 'a', state: 'human' }, { id: 'b-ssh', hostId: 'b', state: 'human' }],
    messages: [], operations: [], inputs: [], approvals: [], profile: { provider: 'test', modelId: 'test-model', hasKey: true, hasJevKey: false } };
}
beforeEach(() => { useUi.setState(useUi.getInitialState(), true); useUi.getState().setSnapshot(snapshot()); });

describe('SSH workspace projection', () => {
  it('keeps background AI sessions from changing the visible terminal or conversation', () => {
    useUi.getState().openTerminal('a-ssh');
    useUi.getState().applyEvent({ type: 'terminal-state', terminalId: 'b-agent', hostId: 'b', taskId: 'b-chat', state: 'agent' });
    expect(useUi.getState().activeTabId).toBe('a-ssh');
    expect(useUi.getState().selectedConversationId).toBe('a-new');
    expect(useUi.getState().tabs.map((tab) => tab.id)).toEqual(['a-ssh']);
    expect(useUi.getState().terminals['b-agent']?.taskId).toBe('b-chat');
  });
  it('follows the selected terminal host and remembers an explicitly selected older conversation', () => {
    useUi.getState().openTerminal('a-ssh');
    useUi.getState().selectConversation('a-old');
    useUi.getState().openTerminal('b-ssh');
    expect(useUi.getState().selectedConversationId).toBe('b-chat');
    useUi.getState().selectTab('a-ssh');
    expect(useUi.getState().activeHostId).toBe('a');
    expect(useUi.getState().selectedConversationId).toBe('a-old');
  });
  it('does not select a previous conversation when a fresh composer receives a snapshot', () => {
    useUi.getState().openTerminal('a-ssh');
    useUi.getState().newConversation('a');
    useUi.getState().setSnapshot(snapshot());
    expect(useUi.getState().selectedConversationId).toBeNull();
    expect(useUi.getState().activeTabId).toBe('a-ssh');
  });
  it('selects the owner conversation only when explicitly opening an AI terminal', () => {
    useUi.getState().applyEvent({ type: 'terminal-state', terminalId: 'agent-old', hostId: 'a', taskId: 'a-old', state: 'agent' });
    useUi.getState().openTerminal('agent-old');
    expect(useUi.getState().selectedConversationId).toBe('a-old');
    const next = snapshot(); next.terminals.push({ id: 'agent-old', hostId: 'a', taskId: 'a-old', state: 'agent' });
    useUi.getState().setSnapshot(next);
    expect(useUi.getState().selectedConversationId).toBe('a-old');
  });
  it('closes the actual terminal tab and projects the adjacent host instead of retaining stale context', () => {
    useUi.getState().openTerminal('a-ssh'); useUi.getState().openTerminal('b-ssh');
    useUi.getState().applyEvent({ type: 'terminal-state', terminalId: 'b-ssh', hostId: 'b', state: 'closed' });
    expect(useUi.getState().terminals['b-ssh']).toBeUndefined();
    expect(useUi.getState().activeTabId).toBe('a-ssh');
    expect(useUi.getState().selectedConversationId).toBe('a-new');
  });
  it('keeps pure chat separate from an authorized server conversation', () => {
    useUi.getState().openTerminal('a-ssh'); useUi.getState().newConversation(null);
    expect(useUi.getState().activeHostId).toBeNull();
    expect(useUi.getState().activeTabId).toBeNull();
    useUi.getState().setSnapshot(snapshot());
    expect(useUi.getState().selectedConversationId).toBeNull();
    useUi.getState().selectTab('a-ssh');
    expect(useUi.getState().selectedConversationId).toBe('a-new');
  });
  it('tracks a monotonically increasing output position after the memory buffer is full', () => {
    useUi.getState().applyEvent({ type: 'terminal-data', terminalId: 'a-ssh', data: 'x'.repeat(100_000) });
    useUi.getState().applyEvent({ type: 'terminal-data', terminalId: 'a-ssh', data: 'new output' });
    expect(useUi.getState().terminals['a-ssh']?.buffer).toHaveLength(100_000);
    expect(useUi.getState().terminals['a-ssh']?.buffer.endsWith('new output')).toBe(true);
    expect(useUi.getState().terminals['a-ssh']?.offset).toBe(10);
    useUi.getState().setSnapshot(snapshot());
    expect(useUi.getState().terminals['a-ssh']?.offset).toBe(10);
  });
  it('deduplicates streamed messages when the same authoritative snapshot arrives', () => {
    const message = { taskId: 'a-new', role: 'agent' as const, text: 'ready', createdAt: 5 };
    useUi.getState().applyEvent({ type: 'task-message', ...message });
    const next = snapshot(); next.messages.push(message);
    useUi.getState().setSnapshot(next);
    useUi.getState().applyEvent({ type: 'task-message', ...message });
    expect(useUi.getState().snapshot?.messages).toHaveLength(1);
  });
  it('retains active sessions when a legacy snapshot omits terminal projections', () => {
    useUi.getState().openTerminal('a-ssh');
    const { terminals: _terminals, ...legacy } = snapshot();
    useUi.getState().setSnapshot(legacy as AppSnapshot);
    expect(useUi.getState().activeTabId).toBe('a-ssh');
    expect(useUi.getState().terminals['a-ssh']).toBeDefined();
  });
});
