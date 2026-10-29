import { afterEach, describe, expect, it, vi } from 'vitest';
import { BashAnalyzer, type SqliteStore } from '@cloudhelm/adapters';
import type { AppEvent, ModelProfileDraft, TaskIntentState, TaskView } from '@cloudhelm/contracts';
import { operationNeedsVerification } from '@cloudhelm/contracts';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';

const encryption = vi.hoisted(() => ({ available: true }));
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => encryption.available,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length)
} }));

class MemoryStore {
  private readonly buckets = new Map<string, Map<string, unknown>>();
  readonly removedLogs: string[] = [];
  get<T>(bucket: string, id: string): T | undefined {
    return structuredClone(this.buckets.get(bucket)?.get(id)) as T | undefined;
  }
  list<T>(bucket: string): T[] { return [...(this.buckets.get(bucket)?.values() ?? [])].map((value) => structuredClone(value) as T); }
  put(bucket: string, id: string, value: unknown): void {
    const values = this.buckets.get(bucket) ?? new Map<string, unknown>();
    values.set(id, structuredClone(value)); this.buckets.set(bucket, values);
  }
  remove(bucket: string, id: string): void { this.buckets.get(bucket)?.delete(id); }
  removeWhere(bucket: string, field: string, value: string): void {
    const values = this.buckets.get(bucket);
    if (!values) return;
    for (const [key, record] of [...values]) if ((record as Record<string, unknown>)[field] === value) values.delete(key);
  }
  removePrefix(bucket: string, idPrefix: string): void {
    const values = this.buckets.get(bucket);
    if (!values) return;
    for (const key of [...values.keys()]) if (key.startsWith(idPrefix)) values.delete(key);
  }
  removeLogs(terminalId: string): void { this.removedLogs.push(terminalId); }
  cleanupLogs(): void {}
  appendLog(): void {}
}

const openStates: AppState[] = [];
function setup(store = new MemoryStore()) {
  const events: AppEvent[] = [];
  const state = new AppState(store as unknown as SqliteStore, (event) => events.push(event));
  openStates.push(state);
  return { state, store, events };
}
const customProfile = (update: Partial<ModelProfileDraft> = {}): ModelProfileDraft => ({
  provider: 'cloudhelm-custom', modelId: 'model-one', baseUrl: 'http://localhost:1234/v1', apiKey: 'key-for-endpoint-one', ...update
});

it('persists the executable runtime directory as a new host revision and resets password caching', () => {
  const { state, store } = setup();
  const draft = { label: 'fixture', address: '192.0.2.1', port: 22, username: 'deploy', auth: 'agent' as const };
  const original = state.addHost({ ...draft, runtimeDirectory: '/home/deploy/run' });
  expect(original.sudoCachePolicy).toEqual({ mode: 'disabled', revision: 1 });
  state.updateHost(original.id, { sudoCachePolicy: { mode: 'single-password-auto', revision: 2 } });
  const renamed = state.editHost(original.id, { ...draft, label: 'renamed', runtimeDirectory: '/home/deploy/run' });
  expect(renamed.id).toBe(original.id);
  expect(renamed.sudoCachePolicy).toEqual({ mode: 'single-password-auto', revision: 2 });
  const replacement = state.editHost(original.id, { ...draft, runtimeDirectory: '/var/tmp' });
  expect(replacement.id).not.toBe(original.id);
  expect(replacement.sudoCachePolicy).toEqual({ mode: 'disabled', revision: 1 });
  expect(state.getHost(original.id)).toMatchObject({ archived: true, runtimeDirectory: '/home/deploy/run' });
  expect(setup(store).state.getHost(replacement.id).runtimeDirectory).toBe('/var/tmp');
});
function conversation(state: AppState): TaskView {
  const profile = state.runtimeProfile();
  const task = state.createTask('Explain container health checks', [], profile.modelId, []);
  state.setTaskModel(task.id, profile);
  return task;
}

afterEach(() => {
  encryption.available = true;
  for (const state of openStates.splice(0)) state.close();
});

it('persists explicit continuation reasons and clears them on completion', () => {
  const { state, store } = setup();
  state.saveProfile(customProfile());
  const task = conversation(state);
  state.record({ type: 'task-status', taskId: task.id, status: 'paused', summary: '等待核验', resumeReason: 'verify' });
  expect(setup(store).state.getTask(task.id)).toMatchObject({ status: 'paused', resumeReason: 'verify' });
  state.record({ type: 'task-status', taskId: task.id, status: 'answered' });
  expect(state.getTask(task.id).resumeReason).toBeUndefined();
  expect(state.getTask(task.id).summary).toBeUndefined();
  expect(setup(store).state.getTask(task.id).resumeReason).toBeUndefined();
});

it('persists an answered but unverified change separately from a verified report', () => {
  const { state, store } = setup();
  state.saveProfile(customProfile());
  const task = conversation(state);
  state.record({ type: 'verification-state', taskId: task.id, value: {
    status: 'unverified', operationIds: ['write-1'], reasonCode: 'report-missing'
  } });
  state.record({ type: 'task-status', taskId: task.id, status: 'answered', resumeReason: 'report', summary: '变更已执行，待核验' });
  expect(setup(store).state.getTask(task.id)).toMatchObject({ status: 'answered', resumeReason: 'report',
    verificationState: { status: 'unverified', operationIds: ['write-1'] } });
  state.record({ type: 'verification-state', taskId: task.id, value: { status: 'verified', operationIds: ['write-1'] } });
  state.record({ type: 'task-status', taskId: task.id, status: 'answered' });
  expect(setup(store).state.getTask(task.id)).toMatchObject({ status: 'answered', verificationState: { status: 'verified' } });
  expect(state.getTask(task.id).resumeReason).toBeUndefined();
});

describe('persisted intent and message provenance', () => {
  it('restores current intent and merged clarification IDs without deriving authority from reprojected text', () => {
    const { state, store } = setup(); state.saveProfile(customProfile());
    const task = conversation(state);
    const intent: TaskIntentState = { version: 1, revision: 3, originalGoal: 'Deploy only in test',
      currentInput: 'Do not restart production', origin: 'explicit', clarifications: [{ id: 'q', text: 'test environment only' }] };
    state.record({ type: 'task-intent', taskId: task.id, value: intent });
    state.record({ type: 'task-message', taskId: task.id, entryId: 'old-input', role: 'user', source: 'input', text: 'older goal', createdAt: 1 });
    state.record({ type: 'task-message', taskId: task.id, entryId: 'answer', role: 'user', source: 'clarification',
      clarificationToolCallId: 'q-tool', text: '[需求澄清回答] test', createdAt: 2 });
    expect(state.getTask(task.id).intent).toEqual(intent);
    expect(setup(store).state.getTask(task.id).intent).toEqual(intent);
    const write = vi.spyOn(store, 'put');
    state.record({ type: 'task-intent', taskId: task.id, value: structuredClone(intent) });
    state.record({ type: 'task-intent', taskId: task.id, value: { ...intent, revision: 2 } });
    expect(write).not.toHaveBeenCalled();
    expect(() => state.record({ type: 'task-intent', taskId: task.id, value: { ...intent, currentInput: 'conflicting snapshot' } })).toThrow('版本冲突');
    write.mockRestore();
  });

  it('fails closed on invalid intent and does not mutate memory if intent persistence fails', () => {
    const { state, store } = setup(); state.saveProfile(customProfile()); const task = conversation(state);
    const intent: TaskIntentState = { version: 1, revision: 1, originalGoal: 'goal', currentInput: 'latest', origin: 'explicit', clarifications: [] };
    expect(() => state.record({ type: 'task-intent', taskId: task.id, value: { ...intent, revision: -1 } })).toThrow('无效');
    const failure = vi.spyOn(store, 'put').mockImplementation(() => { throw new Error('disk full'); });
    try {
      expect(() => state.record({ type: 'task-intent', taskId: task.id, value: intent })).toThrow('disk full');
      expect(state.getTask(task.id).intent).toBeUndefined();
    } finally { failure.mockRestore(); }
  });

  it('enriches a legacy native message with provenance exactly once without adding a duplicate', () => {
    const { state, store } = setup(); state.saveProfile(customProfile()); const task = conversation(state);
    const message = { type: 'task-message' as const, taskId: task.id, entryId: 'native-answer', role: 'user' as const,
      text: '[需求澄清回答] test', createdAt: 1 };
    state.record(message);
    const updated = { ...message, source: 'clarification' as const, clarificationToolCallId: 'tool' };
    state.record(updated);
    const write = vi.spyOn(store, 'put');
    state.record(updated);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    const messages = setup(store).state.snapshot().messages.filter((item) => item.taskId === task.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ source: 'clarification', clarificationToolCallId: 'tool' });
  });
});

describe('conversation credential binding', () => {
  it('keeps terminal replacement in authoritative snapshots after further terminal state events', () => {
    const { state, events } = setup();
    state.record({ type: 'terminal-state', terminalId: 'old', hostId: 'host', taskId: 'task', state: 'human' });
    state.record({ type: 'terminal-state', terminalId: 'new', hostId: 'host', taskId: 'task', state: 'agent' });
    state.record({ type: 'terminal-replaced', previousTerminalId: 'old', terminalId: 'new' });
    state.record({ type: 'terminal-state', terminalId: 'old', hostId: 'host', taskId: 'task', state: 'human' });
    expect(state.snapshot().terminals.find((item) => item.id === 'old')).toMatchObject({ state: 'human', replacementTerminalId: 'new' });
    expect(events).toContainEqual({ type: 'terminal-replaced', previousTerminalId: 'old', terminalId: 'new' });
  });
  it.each([
    { apiKey: 'replacement-account-key' },
    { baseUrl: 'http://localhost:4321/v1', apiKey: undefined },
    { baseUrl: 'http://localhost:4321/v1', apiKey: 'new-endpoint-key' }
  ])('requires explicit reselection after the provider credentials or endpoint change: %j', (update) => {
    const { state, store } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    const inFlightProfile = state.conversationProfile(task);
    state.saveProfile(customProfile(update));
    expect(state.runtimeProfile().credentialRevision).not.toBe(task.credentialRevision);
    expect(() => state.conversationProfile(task)).toThrow('重新选择模型');
    expect(inFlightProfile.apiKey).toBe('key-for-endpoint-one');
    expect(inFlightProfile.baseUrl).toBe('http://localhost:1234/v1');
    const restarted = setup(store).state;
    expect(() => restarted.conversationProfile(restarted.getTask(task.id))).toThrow('重新选择模型');
  });

  it('persists custom model capacity and requires reselection when it changes', () => {
    const { state, store } = setup();
    state.saveProfile(customProfile({ contextWindow: 1_000_000, maxTokens: 384_000 }));
    const task = conversation(state);
    expect(state.conversationProfile(task)).toMatchObject({ contextWindow: 1_000_000, maxTokens: 384_000 });
    expect(state.modelProviderSettings('cloudhelm-custom')).toMatchObject({ contextWindow: 1_000_000, maxTokens: 384_000 });
    expect(setup(store).state.conversationProfile(task).maxTokens).toBe(384_000);
    state.saveProfile(customProfile({ contextWindow: 1_000_000, maxTokens: 128_000 }));
    expect(() => state.conversationProfile(task)).toThrow('重新选择模型');
    expect(() => state.saveProfile(customProfile({ contextWindow: 8192, maxTokens: 384_000 }))).toThrow('容量无效');
  });

  it('keeps the binding when only the default model changes or an identical key is saved', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.saveProfile(customProfile({ modelId: 'model-two' }));
    expect(state.runtimeProfile().credentialRevision).toBe(task.credentialRevision);
    expect(state.conversationProfile(task).modelId).toBe('model-one');
    state.saveProfile(customProfile({ modelId: 'model-three', apiKey: undefined }));
    expect(state.conversationProfile(task).apiKey).toBe('key-for-endpoint-one');
    expect(state.runtimeProfile().credentialRevision).toBe(task.credentialRevision);
  });

  it('can update a live task reviewer without loading newly saved model credentials', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.saveProfile(customProfile({ apiKey: 'another-account-key' }));
    expect(() => state.conversationProfile(task)).toThrow('重新选择模型');
    state.saveReviewSettings({ reviewer: { kind: 'current' } });
    const reviewer = state.runtimeReviewerForLiveTask(task);
    expect(reviewer).toMatchObject({ selection: { kind: 'current' },
      provider: 'cloudhelm-custom', modelId: 'model-one' });
    expect(reviewer.apiKey).toBeUndefined();
  });

  it('does not redirect an existing conversation when another provider becomes the global default', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.saveProfile({ provider: 'openai', modelId: 'gpt-4.1', apiKey: 'other-provider-key' });
    expect(state.runtimeProfile().provider).toBe('openai');
    expect(state.conversationProfile(task)).toMatchObject({ provider: 'cloudhelm-custom', modelId: 'model-one',
      baseUrl: 'http://localhost:1234/v1', apiKey: 'key-for-endpoint-one', credentialRevision: task.credentialRevision });
  });

  it('allows recovery after explicit model reselection and records the new binding without plaintext keys', () => {
    const { state, store, events } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.saveProfile(customProfile({ baseUrl: 'http://localhost:4321/v1', apiKey: 'replacement-account-key' }));
    const chosen = state.runtimeProfile({ provider: 'cloudhelm-custom', modelId: 'model-one' });
    state.setTaskModel(task.id, chosen);
    expect(state.conversationProfile(task)).toMatchObject({ baseUrl: 'http://localhost:4321/v1', apiKey: 'replacement-account-key' });
    expect(JSON.stringify(store.get('tasks', task.id))).not.toContain('replacement-account-key');
    expect(JSON.stringify(state.snapshot())).not.toContain('replacement-account-key');
    expect(JSON.stringify(events)).not.toContain('replacement-account-key');
    expect(store.get<string>('secrets', 'model-key:cloudhelm-custom')).not.toContain('replacement-account-key');
  });

  it('requires legacy conversations to select a model instead of inferring their old account', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    delete task.credentialRevision;
    expect(() => state.conversationProfile(task)).toThrow('重新选择模型');
    state.runtimeProfile();
    expect(() => state.conversationProfile(task)).toThrow('重新选择模型');
  });

  it('creates a revision for a legacy provider without silently binding old conversations', () => {
    const store = new MemoryStore();
    const legacy = { provider: 'cloudhelm-custom', modelId: 'model-one', baseUrl: 'http://localhost:1234/v1' };
    store.put('settings', 'model-profile', legacy);
    store.put('secrets', 'model-key:cloudhelm-custom', Buffer.from('encrypted:legacy-key').toString('base64'));
    const { state } = setup(store);
    const profile = state.runtimeProfile();
    expect(profile.credentialRevision).toEqual(expect.any(String));
    expect(profile.apiKey).toBe('legacy-key');
    expect(state.runtimeProfile().credentialRevision).toBe(profile.credentialRevision);
    const task = state.createTask('Old work', [], legacy.modelId, []);
    expect(() => state.conversationProfile(task)).toThrow('重新选择模型');
  });

  it('does not persist or rebind credentials when testing a settings draft', () => {
    const { state, store } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    const before = store.get('settings', 'model-profile');
    const test = state.testProfile(customProfile({ baseUrl: 'http://localhost:4321/v1', apiKey: 'temporary-test-key' }));
    expect(test.apiKey).toBe('temporary-test-key');
    expect(test.baseUrl).toBe('http://localhost:4321/v1');
    expect(store.get('settings', 'model-profile')).toEqual(before);
    expect(state.conversationProfile(task).credentialRevision).toBe(task.credentialRevision);
  });

  it('does not replace saved defaults if OS encryption is unavailable for a new credential', () => {
    const { state, store } = setup();
    const original = state.snapshot().profile;
    encryption.available = false;
    expect(() => state.saveProfile(customProfile())).toThrow('encryption is unavailable');
    expect(state.snapshot().profile).toEqual(original);
    expect(store.get('settings', 'model-provider:cloudhelm-custom')).toBeUndefined();
  });
});

describe('state disposal', () => {
  it('flushes logs once and ignores late worker events after the database is closed', () => {
    vi.useFakeTimers();
    try {
      const { state, store, events } = setup();
      const append = vi.spyOn(store, 'appendLog');
      state.record({ type: 'terminal-data', terminalId: 'terminal', data: 'final output' });
      state.close();
      expect(append).toHaveBeenCalledOnce();
      const accesses = [vi.spyOn(store, 'get'), vi.spyOn(store, 'put'), vi.spyOn(store, 'cleanupLogs'), append];
      for (const access of accesses) {
        access.mockClear();
        access.mockImplementation(() => { throw new Error('The database connection is not open'); });
      }
      events.length = 0;
      expect(() => {
        state.record({ type: 'task-message', taskId: 'task', role: 'agent', text: 'late result', createdAt: 1 });
        state.record({ type: 'terminal-data', terminalId: 'terminal', data: 'late output' });
        state.runtimeStopped(); state.publish(); state.close();
        vi.advanceTimersByTime(24 * 60 * 60_000);
      }).not.toThrow();
      for (const access of accesses) expect(access).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});


describe('clarification persistence', () => {
  it('expires pending questions on restart while retaining answered questions and pausing the conversation', () => {
    const { state, store } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.record({ type: 'task-status', taskId: task.id, status: 'waiting-user' });
    const request = { id: 'ask', taskId: task.id, toolCallId: 'tool', generation: 'run', questions: [{ id: 'q', prompt: '环境？' }], createdAt: 1, expiresAt: 9999999999999, status: 'pending' as const };
    state.record({ type: 'clarification', value: request });
    state.record({ type: 'clarification', value: { ...request, id: 'answered', status: 'answered', answers: [{ id: 'q', value: '测试', custom: true }] } });
    const restarted = setup(store).state;
    expect(restarted.getTask(task.id).status).toBe('paused');
    expect(restarted.snapshot().clarifications).toEqual([{ ...request, status: 'expired' }, { ...request, id: 'answered', status: 'answered', answers: [{ id: 'q', value: '测试', custom: true }] }]);
    expect(setup(store).state.snapshot().clarifications?.[0]?.status).toBe('expired');
  });
  it('expires questions when the utility process exits', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.record({ type: 'task-status', taskId: task.id, status: 'waiting-user' });
    state.record({ type: 'clarification', value: { id: 'ask', taskId: task.id, toolCallId: 'tool', generation: 'run', questions: [{ id: 'q', prompt: '环境？' }], createdAt: 1, expiresAt: 9999999999999, status: 'pending' } });
    state.runtimeStopped();
    expect(state.getTask(task.id).status).toBe('paused');
    expect(state.snapshot().clarifications?.[0]?.status).toBe('expired');
  });
});

it('persists deliberate interruption metadata separately from observed process outcomes', () => {
  const { state, store } = setup();
  const interruption = { source: 'ctrl-c' as const, requestedAt: 10, operationIds: ['op'] };
  state.record({ type: 'task-message', taskId: 'task', role: 'system', text: '用户通过 Ctrl+C 主动终止执行。', interruption, createdAt: 10 });
  state.record({ type: 'operation', value: { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'sleep 30', status: 'failed', exitCode: 130, createdAt: 1, interruption } });
  const restored = setup(store).state.snapshot();
  expect(restored.messages[0]?.interruption).toEqual(interruption);
  expect(restored.operations[0]).toMatchObject({ status: 'failed', exitCode: 130, interruption });
});

describe('conversation deletion', () => {
  it('removes a finished conversation with its records and terminal logs', () => {
    const { state, store } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.record({ type: 'task-message', taskId: task.id, role: 'user', text: '目标', createdAt: 1 });
    state.record({ type: 'operation', value: { id: 'op', taskId: task.id, hostId: 'host', kind: 'command', preview: 'ls', status: 'succeeded', createdAt: 1, logRef: 'term-1' } });
    state.record({ type: 'terminal-state', terminalId: 'term-1', hostId: 'host', taskId: task.id, state: 'agent' });
    state.deleteTask(task.id);
    expect(store.removedLogs.sort()).toEqual(['operation:op', 'term-1'].sort());
    const restored = setup(store).state.snapshot();
    expect(restored.conversations).toEqual([]);
    expect(restored.messages).toEqual([]);
    expect(restored.operations).toEqual([]);
    expect(restored.terminals).toEqual([]);
  });
  it('keeps other conversations and their logs untouched', () => {
    const { state, store } = setup();
    state.saveProfile(customProfile());
    const removed = conversation(state);
    const kept = conversation(state);
    state.record({ type: 'task-message', taskId: removed.id, role: 'user', text: '删除', createdAt: 1 });
    state.record({ type: 'task-message', taskId: kept.id, role: 'user', text: '保留', createdAt: 2 });
    state.deleteTask(removed.id);
    const restored = setup(store).state.snapshot();
    expect(restored.conversations.map((item) => item.id)).toEqual([kept.id]);
    expect(restored.messages.map((item) => item.text)).toEqual(['保留']);
  });
  it.each(['running', 'waiting-review', 'waiting-user', 'recovering', 'human-control'] as const)(
    'refuses to delete a conversation that still owns live work (%s)', (status) => {
      const { state } = setup();
      state.saveProfile(customProfile());
      const task = conversation(state);
      state.record({ type: 'task-status', taskId: task.id, status });
      expect(() => state.deleteTask(task.id)).toThrow(/进行中/u);
    });
  it('allows deletion after a completed answer, including a verified change report', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.record({ type: 'work-report', taskId: task.id, report: { summary: '已核验', access: ['无'],
      evidenceOperationIds: ['check'], changes: ['完成'], recovery: ['无'] } });
    state.record({ type: 'task-status', taskId: task.id, status: 'answered' });
    expect(() => state.deleteTask(task.id)).not.toThrow();
  });
  it('rejects unknown conversations', () => {
    expect(() => setup().state.deleteTask('missing')).toThrow();
  });
  it('allows deletion after a read-only query loses its output, while retaining unknown writes', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.record({ type: 'operation', value: { id: 'query', taskId: task.id, hostId: 'host', kind: 'command',
      preview: 'df -h', status: 'unknown', readOnly: true, createdAt: 1 } });
    expect(() => state.deleteTask(task.id)).not.toThrow();
    const writeTask = conversation(state);
    state.record({ type: 'operation', value: { id: 'write', taskId: writeTask.id, hostId: 'host', kind: 'command',
      preview: 'touch /tmp/file', status: 'unknown', readOnly: false, createdAt: 2 } });
    expect(() => state.deleteTask(writeTask.id)).toThrow(/远端结果尚未核验/u);
  });
});

describe('shortcut settings persistence', () => {
  it('stores bindings, explicit clears and the master switch', () => {
    const { state, store } = setup();
    const stored = { bindings: { 'tab.close': 'ctrl+w', 'terminal.clear': '' }, enabled: false };
    state.saveShortcuts(stored);
    expect(state.shortcuts()).toEqual(stored);
    expect(setup(store).state.shortcuts()).toEqual(stored);
  });
  it('defaults to enabled shortcuts when nothing is stored', () => {
    expect(setup().state.shortcuts()).toEqual({ bindings: {}, enabled: true });
  });
  it.each([
    ['non-object bindings', { bindings: 'ctrl+w', enabled: true }],
    ['array bindings', { bindings: ['ctrl+w'], enabled: true }],
    ['numeric values', { bindings: { 'tab.close': 5 }, enabled: true }],
    ['unknown characters', { bindings: { 'tab.close': 'ctrl+shift+t!!' }, enabled: true }],
    ['oversized action ids', { bindings: { [ 'x'.repeat(80) ]: 'ctrl+w' }, enabled: true }]
  ])('rejects malformed shortcut settings (%s)', (_name, settings) => {
    expect(() => setup().state.saveShortcuts(settings as never)).toThrow();
  });
});

describe('runtime context usage snapshots', () => {
  it('publishes usage without persisting it and clears it on model change, restart and runtime exit', () => {
    const { state, store, events } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    const value = { model: { provider: task.provider!, modelId: task.modelId }, request: 1,
      usedTokens: 100, contextWindow: 32000, source: 'provider' as const, updatedAt: 10 };
    state.record({ type: 'context-usage', taskId: task.id, value });
    expect(state.snapshot().contextUsage?.[task.id]).toEqual(value);
    expect(events.at(-1)).toMatchObject({ type: 'snapshot', value: { contextUsage: { [task.id]: value } } });
    expect(store.get<TaskView>('tasks', task.id)).not.toHaveProperty('contextUsage');
    expect(setup(store).state.snapshot().contextUsage).toEqual({});
    state.setTaskModel(task.id, state.runtimeProfile());
    expect(state.snapshot().contextUsage).toEqual({});
    state.record({ type: 'context-usage', taskId: task.id, value });
    state.runtimeStopped();
    expect(state.snapshot().contextUsage).toEqual({});
  });
});

it('rebuilds native message projections idempotently and clears compaction status on worker exit', () => {
  const { state, store } = setup();
  state.saveProfile(customProfile());
  const task = conversation(state);
  const message = { type: 'task-message' as const, taskId: task.id, entryId: 'native-entry', role: 'user' as const, text: 'stored intent', createdAt: 10 };
  state.record(message);
  state.record(message);
  expect(state.snapshot().messages).toHaveLength(1);
  expect(store.get('messages', `${task.id}:native-entry`)).toMatchObject({ entryId: 'native-entry' });
  const restarted = setup(store).state;
  restarted.record(message);
  expect(restarted.snapshot().messages).toHaveLength(1);
  restarted.record({ type: 'context-compaction', taskId: task.id, status: 'running' });
  expect(restarted.snapshot().contextCompaction?.[task.id]).toBe('running');
  restarted.setTaskModel(task.id, restarted.runtimeProfile());
  expect(restarted.snapshot().contextCompaction?.[task.id]).toBe('running');
  restarted.runtimeStopped();
  expect(restarted.snapshot().contextCompaction).toEqual({});
  store.removeWhere('messages', 'taskId', task.id);
  const rebuilt = setup(store).state;
  expect(rebuilt.snapshot().messages).toEqual([]);
  rebuilt.record(message);
  expect(rebuilt.snapshot().messages).toHaveLength(1);
});

it('does not infer complete historical source or identity from a plausible preview alone', async () => {
  const { state, store } = setup();
  const cases = [
    { id: 'query', preview: 'docker ps -a', status: 'failed', exitCode: 1 },
    { id: 'listing', preview: 'ls -ld /home/tian/test', status: 'failed', exitCode: 2 },
    { id: 'compound', preview: 'ls /home/tian; touch /home/tian/test', status: 'failed', exitCode: 1 },
    { id: 'unknown', preview: 'ls -ld /home/tian/test', status: 'unknown' },
    { id: 'redacted', preview: 'ls [REDACTED]', status: 'failed', exitCode: 1 }
  ] as const;
  for (const item of cases) state.record({ type: 'operation', value: { ...item, taskId: 'source', hostId: 'host',
    kind: 'command', effects: 'possible', createdAt: 1 } });
  await state.normalizeHistoricalQueries(new BashAnalyzer());
  expect(state.snapshot().operations.filter(operationNeedsVerification).map((item) => item.id))
    .toEqual(['query', 'listing', 'compound', 'unknown', 'redacted']);
  const restored = setup(store).state.snapshot().operations;
  expect(restored.filter(operationNeedsVerification).map((item) => item.id)).toEqual(['query', 'listing', 'compound', 'unknown', 'redacted']);
  expect(restored.find((item) => item.id === 'query')?.status).toBe('failed');
  expect(restored.find((item) => item.id === 'query')?.readOnly).toBeUndefined();
});

it('does not release a historical lock if query analysis fails', async () => {
  const { state } = setup();
  state.record({ type: 'operation', value: { id: 'query', taskId: 'source', hostId: 'host', kind: 'command',
    preview: 'ls -la /home/tian', status: 'failed', effects: 'possible', exitCode: 1, createdAt: 1 } });
  await state.normalizeHistoricalQueries({ analyze: async () => { throw new Error('parser unavailable'); } });
  expect(operationNeedsVerification(state.snapshot().operations[0]!)).toBe(true);
});

it('keeps an unknown outcome truthful while persisting explicit risk acceptance across restart', () => {
  const { state, store } = setup();
  state.saveProfile(customProfile());
  const task = conversation(state);
  state.record({ type: 'operation', value: { id: 'uncertain', taskId: task.id, hostId: 'host', kind: 'command',
    preview: 'mkdir -p /home/tian/test', status: 'unknown', createdAt: 1 } });
  expect(operationNeedsVerification(state.snapshot().operations.at(-1)!)).toBe(true);
  const committed = state.acceptOperationRisk('uncertain', '已检查实际状态，接受仍有未知变更的风险', 42, task.id, []);
  committed.status = 'succeeded'; // The returned IPC snapshot must not alias authoritative state.
  expect(state.snapshot().operations.find((item) => item.id === 'uncertain')?.status).toBe('unknown');
  const saved = store.get<{ status: string; reconciledAt: number }>('operations', 'uncertain');
  expect(saved).toMatchObject({ status: 'unknown', reconciledAt: 42 });
  const restored = setup(store).state.snapshot().operations.find((item) => item.id === 'uncertain')!;
  expect(restored.reconciliation).toMatchObject({ kind: 'risk-accepted', at: 42, sourceTaskId: task.id });
  expect(operationNeedsVerification(restored)).toBe(false);
  expect(setup(store).state.snapshot().execution?.[task.id]?.remote).toBe('idle');
  expect(() => state.acceptOperationRisk('uncertain', '再次解除', 43)).toThrow();
  expect(() => state.assertDeletable(task.id)).not.toThrow();
});

it.each(['old-snapshot', 'competing-evidence', 'actual-exit'] as const)(
  'preserves the first durable risk resolution across a late %s and restart', (kind) => {
    const { state, store } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    const original = { id: 'uncertain', taskId: task.id, hostId: 'host', kind: 'command' as const,
      preview: 'old write', status: 'unknown' as const, effects: 'possible' as const, createdAt: 1 };
    state.record({ type: 'operation', value: original });
    state.acceptOperationRisk(original.id, '用户已明确接受不确定性，不代表操作成功', 42, task.id, []);
    const accepted = state.snapshot().operations.find((item) => item.id === original.id)!;
    const incoming = kind === 'competing-evidence' ? { ...original, status: 'succeeded' as const, reconciledAt: 43,
      reconciliation: { kind: 'evidence' as const, at: 43, outcome: 'succeeded' as const,
        evidenceOperationIds: ['check'], explanation: '竞争核验不能覆盖已落盘的风险确认' } }
      : kind === 'actual-exit' ? { ...original, status: 'failed' as const, exitCode: 130, outputTail: 'late observed exit' } : original;
    state.record({ type: 'operation', value: incoming });
    for (const current of [state, setup(store).state]) {
      const saved = current.snapshot().operations.find((item) => item.id === original.id)!;
      expect(saved.reconciledAt).toBe(42);
      expect(saved.reconciliation).toEqual(accepted.reconciliation);
      expect(saved.status).toBe(kind === 'actual-exit' ? 'failed' : 'unknown');
      if (kind === 'actual-exit') expect(saved).toMatchObject({ exitCode: 130, outputTail: 'late observed exit' });
      expect(operationNeedsVerification(saved)).toBe(false);
    }
  });

it('keeps canonical operation memory unchanged when a late observation cannot be persisted', () => {
  const { state, store } = setup();
  state.saveProfile(customProfile());
  const task = conversation(state);
  state.record({ type: 'operation', value: { id: 'old', taskId: task.id, hostId: 'host', kind: 'command',
    preview: 'old write', status: 'unknown', createdAt: 1 } });
  const accepted = state.acceptOperationRisk('old', '用户接受原操作的不确定风险', 42);
  const failure = vi.spyOn(store, 'put').mockImplementation(() => { throw new Error('disk full'); });
  try {
    expect(() => state.record({ type: 'operation', value: { ...accepted, status: 'failed', exitCode: 130 } })).toThrow('disk full');
    expect(state.snapshot().operations.find((item) => item.id === 'old')).toEqual(accepted);
  } finally { failure.mockRestore(); }
});

it('does not mutate authoritative state when persisting a risk acceptance fails', () => {
  const { state, store } = setup();
  state.saveProfile(customProfile());
  const task = conversation(state);
  state.record({ type: 'operation', value: { id: 'uncertain', taskId: task.id, hostId: 'host', kind: 'command',
    preview: 'old write', status: 'unknown', createdAt: 1 } });
  const original = store.put.bind(store);
  const failure = vi.spyOn(store, 'put').mockImplementation((bucket, id, value) => {
    if (bucket === 'operations') throw new Error('disk full');
    original(bucket, id, value);
  });
  expect(() => state.acceptOperationRisk('uncertain', '人工承担未知结果风险', 42)).toThrow('disk full');
  expect(operationNeedsVerification(state.snapshot().operations.find((item) => item.id === 'uncertain')!)).toBe(true);
  failure.mockRestore();
});

it('does not accept still-running, read-only or completed operations', () => {
  const { state } = setup();
  state.saveProfile(customProfile());
  const task = conversation(state);
  for (const [id, status, readOnly] of [['active', 'running', false], ['query', 'unknown', true], ['done', 'succeeded', false]] as const) {
    state.record({ type: 'operation', value: { id, taskId: task.id, hostId: 'host', kind: 'command', preview: id,
      status, readOnly, createdAt: 1 } });
    expect(() => state.acceptOperationRisk(id, '已检查实际状态，接受仍有未知变更的风险', 42)).toThrow();
  }
});

it('restores a proposed operation as an unknown but resolvable outcome after restart', () => {
  const { state, store } = setup();
  state.saveProfile(customProfile());
  const task = conversation(state);
  state.record({ type: 'operation', value: { id: 'reviewing', taskId: task.id, hostId: 'host', kind: 'command',
    preview: 'command', status: 'proposed', createdAt: 1 } });
  const restored = setup(store).state.snapshot().operations.find((item) => item.id === 'reviewing')!;
  expect(restored.status).toBe('unknown');
  expect(operationNeedsVerification(restored)).toBe(true);
});

it('preserves execution state across model selection and projects uncertainty after restart', () => {
  const { state, store } = setup(); state.saveProfile(customProfile());
  const task = conversation(state);
  state.record({ type: 'execution', taskId: task.id, value: { model: 'idle', remote: 'running', stopping: true, canStop: true } });
  state.setTaskModel(task.id, state.runtimeProfile());
  expect(state.snapshot().execution?.[task.id]).toMatchObject({ remote: 'running', stopping: true });
  state.record({ type: 'operation', value: { id: 'unfinished', taskId: task.id, hostId: 'host', kind: 'command', preview: 'sleep 10', status: 'running', createdAt: 1 } });
  expect(setup(store).state.snapshot().execution?.[task.id]).toEqual({ model: 'idle', remote: 'unknown', stopping: false, canStop: false });
  state.runtimeStopped();
  expect(state.snapshot().execution?.[task.id]).toEqual({ model: 'idle', remote: 'unknown', stopping: false, canStop: false });
});

it('projects live reasoning without database writes, enriches existing native messages once, and restores completed content', () => {
  const { state, store } = setup(); state.saveProfile(customProfile()); const task = conversation(state);
  const reasoning = { text: '接口提供的摘要', kind: 'summary' as const, status: 'complete' as const };
  state.record({ type: 'reasoning-progress', taskId: task.id, value: { id: 'stream', createdAt: 1,
    model: { provider: task.provider!, modelId: task.modelId }, reasoning: { ...reasoning, status: 'streaming' } } });
  expect(store.list('messages')).toHaveLength(0);
  state.runtimeStopped();
  expect(state.snapshot().reasoningProgress?.[task.id]?.reasoning.status).toBe('interrupted');
  const original = { type: 'task-message' as const, taskId: task.id, entryId: 'entry', role: 'agent' as const, text: '答案', createdAt: 1 };
  state.record(original); state.record({ ...original, reasoning }); state.record({ ...original, reasoning });
  expect(state.snapshot().reasoningProgress).toEqual({});
  expect(state.snapshot().messages).toHaveLength(1);
  expect(setup(store).state.snapshot().messages[0]?.reasoning).toEqual(reasoning);
  expect(setup(store).state.snapshot().reasoningProgress).toEqual({});
});
