import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, ConversationStart, HostView, LocalScope, TaskView } from '@cloudhelm/contracts';
import type { RuntimeCall, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';
import { registerConversationIpc } from './conversation-ipc.js';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => unknown>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, listener: (...args: any[]) => unknown) => ipc.handlers.set(channel, listener) } }));

const profile: RuntimeProfile = { provider: 'cloudhelm-custom', modelId: 'model-one', apiKey: 'fixture-api-key',
  baseUrl: 'https://models.example.test/v1', credentialRevision: 'profile-revision' };
const localScope: LocalScope = { path: '/selected/service', kind: 'directory' };
function makeHost(id: string): HostView {
  return { id, label: id, address: `${id}.example.test`, port: 22, username: 'ubuntu', auth: 'agent', status: 'disconnected',
    protectedPaths: [], defaultMode: 'ai-review', policyRevision: 1 };
}
function makeConversation(hostIds: string[] = ['host-a']): TaskView {
  return { id: 'conversation-one', goal: 'Inspect service', hostIds, localScopes: [], status: 'paused', provider: profile.provider,
    modelId: profile.modelId, credentialRevision: profile.credentialRevision, requestCount: 1, requestLimit: 100, createdAt: 1, updatedAt: 1 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipc.handlers.get(`cloudhelm:${channel}`);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return await handler({ sender: 'mock-renderer' }, ...args) as T;
}

function setup(task = makeConversation(), running = false) {
  const hosts = [makeHost('host-a'), makeHost('host-b')];
  if (running) for (const host of hosts) if (task.hostIds.includes(host.id)) host.status = 'connected';
  const conversations = new Map([[task.id, task]]);
  const active = new Set(running ? [task.id] : []);
  const messages: AppSnapshot['messages'] = [];
  const selections = new Map([['selected-token', localScope]]);
  const state = {
    runtimeProfile: vi.fn(() => ({ ...profile })),
    conversationProfile: vi.fn(() => ({ ...profile })),
    getHost: vi.fn((id: string) => { const host = hosts.find((item) => item.id === id); if (!host) throw new Error('Unknown host'); return host; }),
    getTask: vi.fn((id: string) => { const value = conversations.get(id); if (!value) throw new Error('Unknown conversation'); return value; }),
    runtimeHost: vi.fn((id: string) => ({ ...hosts.find((host) => host.id === id)! })),
    snapshot: vi.fn(() => ({ operations: [], messages })),
    createTask: vi.fn((goal: string, hostIds: string[], modelId: string, localScopes: LocalScope[]) => {
      const created = { ...makeConversation(hostIds), id: 'new-conversation', goal, modelId, localScopes };
      conversations.set(created.id, created); return created;
    }),
    setTaskModel: vi.fn((id: string, next: RuntimeProfile) => { Object.assign(conversations.get(id)!, { provider: next.provider, modelId: next.modelId, credentialRevision: next.credentialRevision }); }),
    authorizeTask: vi.fn((id: string, hostIds: string[], scopes: LocalScope[]) => {
      const value = conversations.get(id)!; value.hostIds.push(...hostIds); value.localScopes.push(...scopes);
    }),
    record: vi.fn((message: AppSnapshot['messages'][number]) => { messages.push(message); })
  };
  const call = vi.fn(async (request: RuntimeCall): Promise<unknown> => {
    if (request.method === 'has-task') return active.has(request.taskId);
    if (request.method === 'start-task') active.add(request.task.id);
    return undefined;
  });
  const connectHost = vi.fn(async (id: string) => { hosts.find((host) => host.id === id)!.status = 'connected'; });
  const takeSelections = vi.fn((tokens: string[]) => {
    if (!Array.isArray(tokens) || tokens.some((token) => !selections.has(token))) throw new Error('Invalid local selection token');
    const result = tokens.map((token) => selections.get(token)!); tokens.forEach((token) => selections.delete(token)); return result;
  });
  const restoreSelections = vi.fn((tokens: string[], scopes: LocalScope[]) => { tokens.forEach((token, index) => selections.set(token, scopes[index]!)); });
  registerConversationIpc({ state: state as unknown as AppState, runtime: { call } as unknown as RuntimeBridge, connectHost, takeSelections, restoreSelections });
  return { state, call, connectHost, takeSelections, restoreSelections, active, conversations };
}

beforeEach(() => ipc.handlers.clear());

describe('conversation IPC authorization boundary', () => {
  it.each(['host-a', null])('starts a conversation with only the explicit host or no remote authorization: %s', async (hostId) => {
    const fixture = setup();
    const input: ConversationStart & { hostIds: string[] } = {
      hostId, hostIds: ['host-b'], message: 'Inspect the service', localSelectionTokens: ['selected-token']
    };
    const created = await invoke<TaskView>('start-conversation', input);
    const expectedHosts = hostId ? [hostId] : [];
    expect(created.hostIds).toEqual(expectedHosts);
    expect(fixture.state.createTask).toHaveBeenCalledWith(input.message, expectedHosts, profile.modelId, [localScope]);
    const start = fixture.call.mock.calls.map(([request]) => request).find((request) => request.method === 'start-task');
    expect(start).toMatchObject({ task: { hostIds: expectedHosts }, hosts: expectedHosts.map((id) => ({ id })), profile });
    expect(fixture.connectHost.mock.calls.flat()).toEqual(expectedHosts);
  });

  it.each([['host-a', 'host-b'], { hostId: 'host-a' }, 1, undefined, ''].map((hostId) => ({ hostId })))('rejects malformed host authorization before side effects: $hostId', async ({ hostId }) => {
    const fixture = setup();
    await expect(invoke('start-conversation', { hostId, message: 'Inspect service', localSelectionTokens: [] })).rejects.toThrow();
    expect(fixture.state.createTask).not.toHaveBeenCalled();
    expect(fixture.connectHost).not.toHaveBeenCalled();
    expect(fixture.call).not.toHaveBeenCalled();
  });

  it.each([{ hostIds: ['host-a'] }, { hostIds: [] }])('allows selected local material but never adds remote hosts to follow-up messages: $hostIds', async ({ hostIds }) => {
    const task = makeConversation([...hostIds]);
    const fixture = setup(task, true);
    await invoke('send-message', task.id, 'Also inspect host-b', ['selected-token'], { hostIds: ['host-b'] });
    expect(fixture.state.authorizeTask).toHaveBeenCalledWith(task.id, [], [localScope]);
    expect(fixture.call).toHaveBeenCalledWith({ method: 'authorize-task', taskId: task.id, hosts: [], localScopes: [localScope] });
    expect(fixture.call).toHaveBeenCalledWith({ method: 'task-message', taskId: task.id, text: 'Also inspect host-b' });
    expect(task.hostIds).toEqual(hostIds);
    expect(fixture.connectHost).not.toHaveBeenCalled();
  });

  it.each([
    { channel: 'send-message', running: false }, { channel: 'send-message', running: true },
    { channel: 'resume-task', running: false }, { channel: 'resume-task', running: true }
  ])('keeps historical multihost work read-only in the backend: $channel, active=$running', async ({ channel, running }) => {
    const task = makeConversation(['host-a', 'host-b']);
    const fixture = setup(task, running);
    await expect(invoke(channel, task.id, 'Continue changes', [])).rejects.toThrow();
    expect(fixture.connectHost).not.toHaveBeenCalled();
    expect(fixture.takeSelections).not.toHaveBeenCalled();
    expect(fixture.call.mock.calls.some(([request]) => ['start-task', 'task-message', 'resume-task'].includes(request.method))).toBe(false);
  });

  it('validates the selected model credentials before opening SSH on a new conversation', async () => {
    const fixture = setup();
    fixture.state.runtimeProfile.mockImplementation(() => { throw new Error('API Key is missing'); });
    await expect(invoke('start-conversation', { hostId: 'host-a', message: 'Deploy', localSelectionTokens: [] })).rejects.toThrow('API Key');
    expect(fixture.connectHost).not.toHaveBeenCalled();
    expect(fixture.takeSelections).not.toHaveBeenCalled();
    expect(fixture.state.createTask).not.toHaveBeenCalled();
  });

  it('validates restored credential bindings before opening SSH or consuming selected local material', async () => {
    const fixture = setup();
    fixture.state.conversationProfile.mockImplementation(() => { throw new Error('Please reselect the account'); });
    await expect(invoke('send-message', 'conversation-one', 'Continue', ['selected-token'])).rejects.toThrow('reselect');
    expect(fixture.connectHost).not.toHaveBeenCalled();
    expect(fixture.takeSelections).not.toHaveBeenCalled();
    expect(fixture.call.mock.calls.some(([request]) => request.method === 'start-task')).toBe(false);
  });
});

describe('conversation runtime restoration', () => {
  it.each(['send-message', 'resume-task'])('reconnects an existing runtime before forwarding %s without loading changed credentials', async (channel) => {
    const fixture = setup(makeConversation(), true);
    fixture.state.getHost('host-a').status = 'disconnected';
    fixture.state.conversationProfile.mockImplementation(() => { throw new Error('Saved credentials changed after this runtime started'); });
    const connected = deferred<void>();
    fixture.connectHost.mockImplementation(async (id) => { await connected.promise; fixture.state.getHost(id).status = 'connected'; });
    const pending = invoke(channel, 'conversation-one', 'Continue', []);
    await vi.waitFor(() => expect(fixture.connectHost).toHaveBeenCalledWith('host-a'));
    expect(fixture.call.mock.calls.some(([request]) => ['task-message', 'resume-task', 'start-task'].includes(request.method))).toBe(false);
    connected.resolve();
    await pending;
    expect(fixture.state.conversationProfile).not.toHaveBeenCalled();
    expect(fixture.state.runtimeProfile).not.toHaveBeenCalled();
    expect(fixture.call.mock.calls.filter(([request]) => request.method === 'start-task')).toHaveLength(0);
    expect(fixture.call).toHaveBeenCalledWith(channel === 'send-message'
      ? { method: 'task-message', taskId: 'conversation-one', text: 'Continue' }
      : { method: 'resume-task', taskId: 'conversation-one' });
  });

  it('does not reconnect an already connected live runtime or silently replace its model profile', async () => {
    const fixture = setup(makeConversation(), true);
    await invoke('resume-task', 'conversation-one');
    expect(fixture.connectHost).not.toHaveBeenCalled();
    expect(fixture.state.conversationProfile).not.toHaveBeenCalled();
    expect(fixture.call.mock.calls.some(([request]) => request.method === 'start-task')).toBe(false);
  });

  it('does not forward a message when reconnecting fails and permits a later reconnect', async () => {
    const fixture = setup(makeConversation(), true);
    fixture.state.getHost('host-a').status = 'disconnected';
    fixture.connectHost.mockRejectedValueOnce(new Error('SSH host fingerprint changed'));
    await expect(invoke('send-message', 'conversation-one', 'Continue', ['selected-token'])).rejects.toThrow('fingerprint changed');
    expect(fixture.takeSelections).not.toHaveBeenCalled();
    expect(fixture.call.mock.calls.some(([request]) => ['task-message', 'start-task'].includes(request.method))).toBe(false);
    await invoke('send-message', 'conversation-one', 'Continue', ['selected-token']);
    expect(fixture.connectHost).toHaveBeenCalledTimes(2);
    expect(fixture.call.mock.calls.filter(([request]) => request.method === 'task-message')).toHaveLength(1);
    expect(fixture.state.conversationProfile).not.toHaveBeenCalled();
  });

  it('shares a reconnect across concurrent requests for the same live runtime', async () => {
    const fixture = setup(makeConversation(), true);
    fixture.state.getHost('host-a').status = 'disconnected';
    const connected = deferred<void>();
    fixture.connectHost.mockImplementation(async (id) => { await connected.promise; fixture.state.getHost(id).status = 'connected'; });
    const pending = [invoke('send-message', 'conversation-one', 'Continue', []), invoke('resume-task', 'conversation-one')];
    await vi.waitFor(() => expect(fixture.connectHost).toHaveBeenCalledTimes(1));
    connected.resolve();
    await Promise.all(pending);
    expect(fixture.connectHost).toHaveBeenCalledTimes(1);
    expect(fixture.call.mock.calls.filter(([request]) => request.method === 'start-task')).toHaveLength(0);
  });

  it('coalesces concurrent message/resume restoration instead of starting the same runtime twice', async () => {
    const fixture = setup();
    const hasTask = deferred<boolean>();
    fixture.call.mockImplementation(async (request) => {
      if (request.method === 'has-task') return hasTask.promise;
      if (request.method === 'start-task') fixture.active.add(request.task.id);
      return undefined;
    });
    const pending = [invoke('send-message', 'conversation-one', 'Continue', []), invoke('resume-task', 'conversation-one')];
    hasTask.resolve(false);
    await Promise.all(pending);
    expect(fixture.call.mock.calls.filter(([request]) => request.method === 'start-task')).toHaveLength(1);
    expect(fixture.connectHost).toHaveBeenCalledTimes(1);
    expect(fixture.call).toHaveBeenCalledWith({ method: 'task-message', taskId: 'conversation-one', text: 'Continue' });
  });

  it('allows a later restoration attempt after an earlier start failed', async () => {
    const fixture = setup();
    let fail = true;
    fixture.call.mockImplementation(async (request) => {
      if (request.method === 'has-task') return false;
      if (request.method === 'start-task' && fail) { fail = false; throw new Error('Runtime launch failed'); }
      return undefined;
    });
    await expect(invoke('resume-task', 'conversation-one')).rejects.toThrow('Runtime launch failed');
    await expect(invoke('resume-task', 'conversation-one')).resolves.toBeUndefined();
    expect(fixture.call.mock.calls.filter(([request]) => request.method === 'start-task')).toHaveLength(2);
  });
});
