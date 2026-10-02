import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import { Value } from 'typebox/value';
import { SqliteStore, listModelProviders, validModelUrl } from '@cloudhelm/adapters';
import { OutputRedactor } from '@cloudhelm/core';
import { HostDraftSchema, type AppEvent, type AppSnapshot, type ModelChoice, type ModelProfileDraft, type TerminalViewState, type HostDraft, type HostView, type InputRequestView, type LocalScope, type ModelProviderSettings, type OperationView, type TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeProfile } from '@cloudhelm/contracts/runtime';

interface ProfileRecord { provider: string; modelId: string; baseUrl?: string; credentialRevision?: string }

export class AppState {
  private readonly hosts = new Map<string, HostView>();
  private readonly terminals = new Map<string, TerminalViewState>();
  private readonly tasks = new Map<string, TaskView>();
  private readonly operations = new Map<string, OperationView>();
  private readonly approvals = new Map<string, AppSnapshot['approvals'][number]>();
  private readonly inputs = new Map<string, AppSnapshot['inputs'][number]>();
  private readonly messages: AppSnapshot['messages'] = [];
  private readonly logBuffer = new Map<string, string>();
  private readonly redactors = new Map<string, OutputRedactor>();
  private logFlushTimer?: ReturnType<typeof setTimeout>;
  private readonly retentionTimer: ReturnType<typeof setInterval>;
  private profile: ProfileRecord;

  constructor(private readonly store: SqliteStore, private readonly emit: (event: AppEvent) => void) {
    for (const host of store.list<HostView>('hosts')) this.hosts.set(host.id, { ...host, status: 'disconnected', policyRevision: host.policyRevision ?? 1 });
    for (const task of store.list<TaskView>('tasks')) this.tasks.set(task.id,
      task.status === 'running' || task.status === 'waiting-review'
        ? { ...task, localScopes: task.localScopes ?? [], status: 'recovering' }
        : { ...task, localScopes: task.localScopes ?? [] });
    for (const operation of store.list<OperationView>('operations')) this.operations.set(operation.id,
      operation.status === 'approved' || operation.status === 'running' ? { ...operation, status: 'unknown', reason: 'Application exited before outcome was recorded' } : operation);
    this.messages.push(...store.list<AppSnapshot['messages'][number]>('messages').sort((a, b) => a.createdAt - b.createdAt));
    this.profile = store.get<ProfileRecord>('settings', 'model-profile') ?? { provider: 'vercel-ai-gateway', modelId: 'anthropic/claude-sonnet-4.5' };
    store.cleanupLogs();
    this.retentionTimer = setInterval(() => store.cleanupLogs(), 24 * 60 * 60_000);
  }

  snapshot(): AppSnapshot {
    return {
      hosts: [...this.hosts.values()], terminals: [...this.terminals.values()], conversations: [...this.tasks.values()], operations: [...this.operations.values()],
      approvals: [...this.approvals.values()], inputs: [...this.inputs.values()], messages: [...this.messages],
      profile: { ...this.profile, hasKey: !!this.profileSecret(), hasJevKey: !!this.secret('jev-key:vercel-ai-gateway') }
    };
  }

  addHost(draft: HostDraft): HostView {
    if (!Value.Check(HostDraftSchema, draft)) throw new Error('Invalid host settings');
    if (draft.jumpHostId && (!this.hosts.has(draft.jumpHostId) || this.getHost(draft.jumpHostId).archived
      || this.getHost(draft.jumpHostId).jumpHostId)) {
      throw new Error('Choose an existing direct SSH host as the single jump host');
    }
    const host: HostView = { ...draft, id: randomUUID(), status: 'disconnected', protectedPaths: [], defaultMode: 'ai-review', policyRevision: 1 };
    this.hosts.set(host.id, host);
    this.store.put('hosts', host.id, host);
    this.publish();
    return host;
  }

  getHost(id: string): HostView {
    const host = this.hosts.get(id);
    if (!host) throw new Error('Host not found');
    return host;
  }

  editHost(id: string, draft: HostDraft, newSecret?: string): HostView {
    if (!Value.Check(HostDraftSchema, draft)) throw new Error('Invalid host settings');
    if (draft.jumpHostId && (!this.hosts.has(draft.jumpHostId) || this.getHost(draft.jumpHostId).archived
      || this.getHost(draft.jumpHostId).jumpHostId)) throw new Error('Choose an active direct host as the jump host');
    const previous = this.getHost(id);
    if (previous.archived) throw new Error('An archived host revision cannot be edited');
    const connectionChanged = previous.address !== draft.address || previous.port !== draft.port
      || previous.username !== draft.username || previous.auth !== draft.auth
      || previous.privateKeyPath !== draft.privateKeyPath || previous.jumpHostId !== draft.jumpHostId || !!newSecret;
    if (!connectionChanged) {
      const renamed = { ...previous, label: draft.label };
      this.hosts.set(id, renamed);
      this.store.put('hosts', id, renamed);
      this.publish();
      return renamed;
    }
    let ciphertext: string | undefined;
    if (newSecret) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
      ciphertext = safeStorage.encryptString(newSecret).toString('base64');
    } else if (previous.auth === draft.auth) ciphertext = this.store.get<string>('secrets', `host:${id}`);
    const replacement: HostView = {
      ...previous, ...draft, previousHostId: previous.id, id: randomUUID(), archived: false, status: 'disconnected', policyRevision: 1,
      fingerprint: previous.address === draft.address && previous.port === draft.port ? previous.fingerprint : undefined
    };
    const archived = { ...previous, archived: true };
    this.hosts.set(id, archived);
    this.hosts.set(replacement.id, replacement);
    this.store.put('hosts', id, archived);
    this.store.put('hosts', replacement.id, replacement);
    if (ciphertext) this.store.put('secrets', `host:${replacement.id}`, ciphertext);
    this.publish();
    return replacement;
  }

  getTask(id: string): TaskView {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Task not found');
    return task;
  }

  acceptTask(id: string): void {
    const task = this.getTask(id);
    if (task.status !== 'ready-for-review') throw new Error('Only a completed task awaiting review can be accepted');
    const accepted = { ...task, status: 'accepted' as const, updatedAt: Date.now() };
    this.tasks.set(id, accepted);
    this.store.put('tasks', id, accepted);
    this.publish();
  }

  updateHost(id: string, change: Partial<HostView>): HostView {
    const host = { ...this.getHost(id), ...change };
    this.hosts.set(id, host);
    this.store.put('hosts', id, host);
    this.publish();
    return host;
  }

  runtimeHost(id: string): RuntimeHost {
    const host = this.getHost(id);
    return { ...host, secret: this.secret(`host:${id}`) };
  }

  saveSecret(id: string, value: string): void {
    this.store.put('secrets', id, this.encryptSecret(value));
    this.publish();
  }

  private encryptSecret(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
    return safeStorage.encryptString(value).toString('base64');
  }

  private secret(id: string): string | undefined {
    const ciphertext = this.store.get<string>('secrets', id);
    if (!ciphertext) return undefined;
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential decryption is unavailable');
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  }

  saveProfile(draft: { provider: string; modelId: string; baseUrl?: string; apiKey?: string }): void {
    const provider = listModelProviders().find((candidate) => candidate.id === draft.provider);
    if (!provider) throw new Error('Choose a Pi model provider');
    const modelId = draft.modelId.trim();
    if (!modelId || (provider.id !== 'cloudhelm-custom' && !provider.models.some((model) => model.id === modelId))) {
      throw new Error('Choose a model from the selected Pi provider');
    }
    const requestedUrl = draft.baseUrl?.trim();
    if (provider.id === 'cloudhelm-custom' && !requestedUrl) throw new Error('Custom model URL is required');
    const baseUrl = requestedUrl && requestedUrl !== provider.defaultBaseUrl ? validModelUrl(requestedUrl) : undefined;
    const legacyKey = this.sameProfileProvider(provider.id, provider.name) ? this.profileSecret() : undefined;
    const previous = this.store.get<ProfileRecord>('settings', `model-provider:${provider.id}`);
    const savedKey = this.secret(this.modelSecretId(provider.id));
    const previousKey = savedKey ?? legacyKey;
    const keyToSave = draft.apiKey || (!savedKey ? legacyKey : undefined);
    // Encrypt before changing defaults: OS keychain failure must leave the prior profile intact.
    const ciphertext = keyToSave ? this.encryptSecret(keyToSave) : undefined;
    const credentialRevision = previous?.credentialRevision && previous.baseUrl === baseUrl
      && (!draft.apiKey || draft.apiKey === previousKey) ? previous.credentialRevision : randomUUID();
    this.profile = { provider: provider.id, modelId, baseUrl, credentialRevision };
    this.store.put('settings', 'model-profile', this.profile);
    this.store.put('settings', `model-provider:${provider.id}`, { modelId, baseUrl, credentialRevision });
    if (ciphertext) this.store.put('secrets', this.modelSecretId(provider.id), ciphertext);
    this.publish();
  }

  saveReviewSettings(settings: { jevKey?: string; disableJev?: boolean }): void {
    if (settings.jevKey) this.saveSecret('jev-key:vercel-ai-gateway', settings.jevKey);
    if (settings.disableJev) this.store.remove('secrets', 'jev-key:vercel-ai-gateway');
    this.publish();
  }

  reviewKey(): string | undefined { return this.secret('jev-key:vercel-ai-gateway'); }

  runtimeProfile(selection?: ModelChoice & { baseUrl?: string }): RuntimeProfile {
    const choice = selection ?? this.profile;
    const saved = this.modelProviderSettings(choice.provider);
    const provider = listModelProviders().find((item) => item.id === choice.provider);
    if (!provider || (provider.id !== 'cloudhelm-custom' && !provider.models.some((item) => item.id === choice.modelId))) {
      throw new Error('所选模型不在供应商目录中');
    }
    const apiKey = this.secret(this.modelSecretId(choice.provider))
      ?? (this.sameProfileProvider(provider.id, provider.name) ? this.profileSecret() : undefined);
    if (!apiKey) throw new Error('请先配置所选供应商的 API Key');
    let binding = this.store.get<ProfileRecord>('settings', `model-provider:${provider.id}`);
    if (!binding?.credentialRevision) {
      binding = { provider: provider.id, modelId: choice.modelId, baseUrl: saved.baseUrl, credentialRevision: randomUUID() };
      this.store.put('settings', `model-provider:${provider.id}`, binding);
    }
    return { ...choice, baseUrl: choice.baseUrl ?? saved.baseUrl ?? provider.defaultBaseUrl, apiKey,
      credentialRevision: binding.credentialRevision, jevKey: this.secret('jev-key:vercel-ai-gateway') };
  }

  conversationProfile(task: TaskView): RuntimeProfile {
    if (!task.provider || !task.credentialRevision) throw new Error('这段历史对话尚未绑定模型凭据，请先在输入框重新选择模型。');
    const binding = this.store.get<ProfileRecord>('settings', `model-provider:${task.provider}`);
    if (binding?.credentialRevision !== task.credentialRevision) {
      throw new Error('这段对话使用的 API Key 或地址已变更，请重新选择模型以确认新的连接和计费账户。');
    }
    return this.runtimeProfile({ provider: task.provider, modelId: task.modelId, baseUrl: task.baseUrl });
  }

  testProfile(draft: ModelProfileDraft): RuntimeProfile {
    const provider = listModelProviders().find((item) => item.id === draft.provider);
    if (!provider || !draft.modelId.trim()) throw new Error('请选择供应商和模型');
    const apiKey = draft.apiKey?.trim() || this.secret(this.modelSecretId(draft.provider))
      || (this.sameProfileProvider(provider.id, provider.name) ? this.profileSecret() : undefined);
    if (!apiKey) throw new Error('请输入 API Key');
    return { provider: draft.provider, modelId: draft.modelId, apiKey,
      baseUrl: draft.baseUrl ? validModelUrl(draft.baseUrl) : undefined };
  }

  availableModels(): Array<ModelChoice & { name: string }> {
    return listModelProviders().flatMap((provider) => {
      const settings = this.modelProviderSettings(provider.id);
      if (!settings.hasKey) return [];
      const models = provider.id === 'cloudhelm-custom' && settings.modelId
        ? [{ id: settings.modelId, name: settings.modelId }] : provider.models;
      return models.map((model) => ({ provider: provider.id, modelId: model.id, name: `${provider.name} · ${model.name}` }));
    });
  }

  setTaskModel(id: string, profile: RuntimeProfile): void {
    const task = this.getTask(id);
    Object.assign(task, { provider: profile.provider, modelId: profile.modelId, baseUrl: profile.baseUrl, credentialRevision: profile.credentialRevision, updatedAt: Date.now() });
    this.store.put('tasks', id, task);
    this.publish();
  }

  archiveHost(id: string): void { this.updateHost(id, { archived: true, status: 'disconnected' }); }

  modelProviderSettings(providerId: string): ModelProviderSettings {
    const provider = listModelProviders().find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error('Unknown Pi model provider');
    const saved = this.store.get<Pick<ProfileRecord, 'modelId' | 'baseUrl'>>('settings', `model-provider:${providerId}`);
    const active = this.sameProfileProvider(provider.id, provider.name) ? this.profile : undefined;
    const legacyKey = active ? this.secret(this.legacyModelSecretId(active)) : undefined;
    return {
      modelId: saved?.modelId ?? active?.modelId,
      baseUrl: saved?.baseUrl ?? active?.baseUrl,
      hasKey: !!(this.secret(this.modelSecretId(providerId)) ?? legacyKey)
    };
  }

  private profileSecret(): string | undefined {
    return this.secret(this.modelSecretId(this.profile.provider)) ?? this.secret(this.legacyModelSecretId(this.profile));
  }

  private modelSecretId(providerId: string): string { return `model-key:${providerId}`; }
  private sameProfileProvider(id: string, name: string): boolean {
    const current = this.profile.provider.toLowerCase();
    return current === id.toLowerCase() || current === name.toLowerCase();
  }
  private legacyModelSecretId(profile: ProfileRecord): string {
    return `model-key:${profile.provider}:${profile.modelId}:${profile.baseUrl ?? ''}`;
  }

  readTerminalLog(id: string): string {
    this.flushLogs();
    return this.store.readLog(id);
  }

  readOperationLog(taskId: string, operationId: string, cursor: number) {
    if (this.operations.get(operationId)?.taskId !== taskId) throw new Error('Operation is outside the conversation');
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid log cursor');
    this.flushLogs();
    return this.store.readLogPage(`operation:${operationId}`, cursor);
  }

  createTask(goal: string, hostIds: string[], modelId: string, localScopes: LocalScope[]): TaskView {
    const authorized = [...new Set(hostIds)];
    if (!goal.trim() || authorized.some((id) => !this.hosts.has(id))) throw new Error('Describe a goal and select valid hosts');
    const now = Date.now();
    const task: TaskView = {
      id: randomUUID(), goal: goal.trim(), hostIds: authorized, localScopes, status: 'draft', modelId, provider: this.profile.provider, baseUrl: this.profile.baseUrl,
      requestCount: 0, requestLimit: 100, createdAt: now, updatedAt: now
    };
    this.tasks.set(task.id, task);
    this.store.put('tasks', task.id, task);
    this.publish();
    return task;
  }

  authorizeTask(taskId: string, hostIds: string[], localScopes: LocalScope[]): void {
    const task = this.getTask(taskId);
    const authorized = [...new Set([...task.hostIds, ...hostIds])];
    if (authorized.some((id) => !this.hosts.has(id))) throw new Error('Unknown authorization target');
    const scopes = [...task.localScopes, ...localScopes]
      .filter((scope, index, all) => all.findIndex((candidate) => candidate.path === scope.path && candidate.kind === scope.kind) === index);
    const updated = { ...task, hostIds: authorized, localScopes: scopes, updatedAt: Date.now() };
    this.tasks.set(taskId, updated);
    this.store.put('tasks', taskId, updated);
    this.publish();
  }

  record(event: AppEvent | { type: 'approval-open'; value: AppSnapshot['approvals'][number] }
    | { type: 'approval-close'; id: string } | { type: 'operation'; value: OperationView }
    | { type: 'input-open'; value: InputRequestView } | { type: 'input-close'; id: string }
    | { type: 'task-status'; taskId: string; status: TaskView['status']; summary?: string; requestCount?: number }
    | { type: 'host-status'; hostId: string; status: HostView['status'] }): void {
    switch (event.type) {
      case 'operation':
        if (event.value.logRef && ['succeeded', 'failed'].includes(event.value.status)) {
          const id = event.value.logRef;
          const tail = this.redactors.get(id)?.finish() ?? '';
          this.redactors.delete(id);
          this.logBuffer.set(id, (this.logBuffer.get(id) ?? '') + tail);
          const key = `operation:${event.value.id}`;
          this.logBuffer.set(key, (this.logBuffer.get(key) ?? '') + tail);
        }
        this.operations.set(event.value.id, event.value);
        this.store.put('operations', event.value.id, event.value);
        break;
      case 'approval-open': this.approvals.set(event.value.id, event.value); break;
      case 'approval-close': this.approvals.delete(event.id); break;
      case 'input-open': this.inputs.set(event.value.id, event.value); break;
      case 'input-close': this.inputs.delete(event.id); break;
      case 'host-status': this.updateHost(event.hostId, { status: event.status }); break;
      case 'task-status': {
        const task = this.tasks.get(event.taskId);
        if (task) {
          Object.assign(task, { status: event.status, updatedAt: Date.now(), summary: event.summary ?? (event.status === 'running' ? undefined : task.summary), requestCount: event.requestCount ?? task.requestCount });
          this.store.put('tasks', task.id, task);
        }
        break;
      }
      case 'task-message': {
        const message = { taskId: event.taskId, role: event.role, text: event.text, createdAt: event.createdAt, model: event.model };
        this.messages.push(message);
        this.store.put('messages', `${event.createdAt}:${randomUUID()}`, message);
        break;
      }
      case 'terminal-data': {
        const redactor = this.redactors.get(event.terminalId) ?? new OutputRedactor();
        this.redactors.set(event.terminalId, redactor);
        const clean = redactor.push(event.data);
        const current = this.logBuffer.get(event.terminalId) ?? '';
        this.logBuffer.set(event.terminalId, current + clean);
        if (event.operationId) {
          const key = `operation:${event.operationId}`;
          this.logBuffer.set(key, (this.logBuffer.get(key) ?? '') + clean);
        }
        if ((this.logBuffer.get(event.terminalId)?.length ?? 0) >= 32_768) this.flushLogs();
        else if (!this.logFlushTimer) this.logFlushTimer = setTimeout(() => this.flushLogs(), 500);
        break;
      }
      case 'terminal-state': {
        if (event.state === 'closed') this.terminals.delete(event.terminalId);
        else this.terminals.set(event.terminalId, { id: event.terminalId, hostId: event.hostId, taskId: event.taskId, state: event.state });
        if (event.state === 'closed') {
          const tail = this.redactors.get(event.terminalId)?.finish() ?? '';
          this.logBuffer.set(event.terminalId, (this.logBuffer.get(event.terminalId) ?? '') + tail);
          this.redactors.delete(event.terminalId);
          this.flushLogs();
        }
        break;
      }
      case 'model-request':
        this.store.put('model-requests', `${event.taskId}:${event.request}`, event);
        break;
      case 'work-progress':
      case 'work-report': {
        const task = this.getTask(event.taskId);
        if (event.type === 'work-progress') task.plan = event.plan;
        else task.report = event.report;
        this.store.put('tasks', task.id, task);
        break;
      }
      case 'snapshot': break;
    }
    if (event.type !== 'terminal-data') this.publish();
    if (event.type === 'terminal-data' || event.type === 'terminal-state' || event.type === 'task-message' || event.type === 'model-request') this.emit(event);
  }

  publish(): void { this.emit({ type: 'snapshot', value: this.snapshot() }); }

  runtimeStopped(): void {
    for (const host of this.hosts.values()) if (host.status === 'connected' || host.status === 'connecting') {
      this.updateHost(host.id, { status: 'disconnected' });
    }
    for (const terminal of this.terminals.values()) this.record({ type: 'terminal-state', terminalId: terminal.id,
      hostId: terminal.hostId, taskId: terminal.taskId, state: 'closed' });
    for (const operation of this.operations.values()) if (['running', 'approved'].includes(operation.status)) {
      this.record({ type: 'operation', value: { ...operation, status: 'unknown', reason: '运行进程退出，远端结果待核验。' } });
    }
    for (const task of this.tasks.values()) if (['running', 'waiting-review', 'human-control', 'paused'].includes(task.status)) {
      this.record({ type: 'task-status', taskId: task.id, status: 'recovering', summary: '运行进程已停止，请重新打开 CloudHelm 后核验远端状态。' });
    }
    this.approvals.clear(); this.inputs.clear(); this.publish();
  }

  close(): void {
    if (this.logFlushTimer) clearTimeout(this.logFlushTimer);
    clearInterval(this.retentionTimer);
    for (const [id, redactor] of this.redactors) {
      this.logBuffer.set(id, (this.logBuffer.get(id) ?? '') + redactor.finish());
    }
    this.redactors.clear();
    this.flushLogs();
  }

  private flushLogs(): void {
    if (this.logFlushTimer) clearTimeout(this.logFlushTimer);
    this.logFlushTimer = undefined;
    for (const [id, data] of this.logBuffer) if (data) this.store.appendLog(id, data);
    this.logBuffer.clear();
  }
}
