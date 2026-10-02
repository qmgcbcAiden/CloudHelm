import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqliteStore } from '@cloudhelm/adapters';
import type { AppEvent, ModelProfileDraft, TaskView } from '@cloudhelm/contracts';
import { AppState } from './app-state.js';

const encryption = vi.hoisted(() => ({ available: true }));
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => encryption.available,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length)
} }));

class MemoryStore {
  private readonly buckets = new Map<string, Map<string, unknown>>();
  get<T>(bucket: string, id: string): T | undefined {
    return structuredClone(this.buckets.get(bucket)?.get(id)) as T | undefined;
  }
  list<T>(bucket: string): T[] { return [...(this.buckets.get(bucket)?.values() ?? [])].map((value) => structuredClone(value) as T); }
  put(bucket: string, id: string, value: unknown): void {
    const values = this.buckets.get(bucket) ?? new Map<string, unknown>();
    values.set(id, structuredClone(value)); this.buckets.set(bucket, values);
  }
  remove(bucket: string, id: string): void { this.buckets.get(bucket)?.delete(id); }
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

describe('conversation credential binding', () => {
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
