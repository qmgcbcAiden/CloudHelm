import { customModelLimits, modelThinking } from '@cloudhelm/adapters';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import { Value } from 'typebox/value';
import { SqliteStore, listModelProviders, validModelUrl } from '@cloudhelm/adapters';
import { OutputRedactor, type CommandAnalyzer } from '@cloudhelm/core';
import { HISTORICAL_QUERY_REPAIR, planHistoricalQueryRepair } from './historical-query-repair.js';
import { RequestBudgetAuthority } from './request-budget-authority.js';
import { createRequestBudget } from '@cloudhelm/core';
import { recordVerificationReport } from './verification-records.js';
import { rebuildRecordedVerification } from './rebuild-verification.js';
import { verificationReason } from '../worker/verification-facts.js';
import { createBudgetRequestHandler } from './request-budget-broker.js';
import { HostDraftSchema, TaskIntentStateSchema, isActiveTaskStatus, operationNeedsVerification, operationOutcomeResolvable, retainOperationResolution, type AppEvent, type AppSnapshot, type ClarificationRequest, type ModelChoice, type ModelProfileDraft, type TerminalViewState, type HostDraft, type HostView, type InputRequestView, type LocalScope, type ModelProviderSettings, type OperationView, type ReviewMode, type ReviewSelection, type ResumeReason, type TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeProfile, RuntimeReviewProfile } from '@cloudhelm/contracts/runtime';

interface ProfileRecord { provider: string; modelId: string; baseUrl?: string; contextWindow?: number; maxTokens?: number; credentialRevision?: string }
interface StoredShortcuts { bindings: Record<string, string>; enabled: boolean }
interface StoredReviewer { selection: ReviewSelection; revision: number }

const SHORTCUT_ACTION_LIMIT = 128;
const SHORTCUT_BINDING_PATTERN = /^[a-z0-9+]{0,40}$/u;

function validBindings(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > SHORTCUT_ACTION_LIMIT) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9.]{1,40}$/u.test(key) || typeof value !== 'string' || !SHORTCUT_BINDING_PATTERN.test(value)) continue;
    result[key] = value;
  }
  return result;
}

export class AppState {
  readonly requestBudgets: RequestBudgetAuthority;
  private budgetPreparationActive: (requestId: string, taskId?: string) => boolean = () => false;
  private readonly hosts = new Map<string, HostView>();
  private readonly terminals = new Map<string, TerminalViewState>();
  private readonly tasks = new Map<string, TaskView>();
  private readonly operations = new Map<string, OperationView>();
  private readonly approvals = new Map<string, AppSnapshot['approvals'][number]>();
  private readonly inputs = new Map<string, AppSnapshot['inputs'][number]>();
  private readonly clarifications = new Map<string, ClarificationRequest>();
  private readonly reasoningProgress: NonNullable<AppSnapshot['reasoningProgress']> = {};
  private readonly execution: NonNullable<AppSnapshot['execution']> = {};
  private readonly contextUsage: NonNullable<AppSnapshot['contextUsage']> = {};
  private readonly contextCompaction: NonNullable<AppSnapshot['contextCompaction']> = {};
  private readonly messages: AppSnapshot['messages'] = [];
  private readonly logBuffer = new Map<string, string>();
  private readonly redactors = new Map<string, OutputRedactor>();
  private logFlushTimer?: ReturnType<typeof setTimeout>;
  private readonly retentionTimer: ReturnType<typeof setInterval>;
  private profile: ProfileRecord;
  private closed = false;
  private revalidatePreparations?: () => void;

  constructor(private readonly store: SqliteStore, private readonly emit: (event: AppEvent) => void) {
    for (const host of store.list<HostView>('hosts')) this.hosts.set(host.id, { ...host, status: 'disconnected',
      protectedReadPaths: host.protectedReadPaths ?? host.protectedPaths ?? [],
      protectedWritePaths: host.protectedWritePaths ?? host.protectedPaths ?? [], policyRevision: host.policyRevision ?? 1,
      sudoCachePolicy: host.sudoCachePolicy ?? { mode: 'disabled', revision: 1 } });
    for (const task of store.list<TaskView>('tasks')) this.tasks.set(task.id,
      task.status === 'running' || task.status === 'waiting-review'
        ? { ...task, localScopes: task.localScopes ?? [], reviewModesByHost: task.reviewModesByHost ?? {}, reviewRevision: task.reviewRevision ?? 1, status: 'recovering' }
        : { ...task, localScopes: task.localScopes ?? [], reviewModesByHost: task.reviewModesByHost ?? {}, reviewRevision: task.reviewRevision ?? 1,
          ...(task.status === 'waiting-user' ? { status: 'paused' as const } : {}) });
    for (const request of store.list<ClarificationRequest>('clarifications')) {
      const restored = request.status === 'pending' ? { ...request, status: 'expired' as const } : request;
      this.clarifications.set(restored.id, restored);
      if (restored !== request) store.put('clarifications', restored.id, restored);
    }
    for (const operation of store.list<OperationView>('operations')) this.operations.set(operation.id,
      // A stored in-flight state can no longer be observed after restart: treat it as
      // an unknown outcome so it stays blocking but is resolvable through recovery.
      operation.status === 'approved' || operation.status === 'running' || operation.status === 'proposed'
        ? { ...operation, manualReviewAvailable: false, status: 'unknown', reason: 'Application exited before outcome was recorded' }
        : { ...operation, manualReviewAvailable: false });
    for (const task of this.tasks.values()) this.execution[task.id] = { model: 'idle', stopping: false, canStop: false,
      remote: [...this.operations.values()].some((op) => op.taskId === task.id && op.status === 'unknown' && !op.reconciledAt) ? 'unknown' : 'idle' };
    this.messages.push(...store.list<AppSnapshot['messages'][number]>('messages').sort((a, b) => a.createdAt - b.createdAt));
    this.profile = store.get<ProfileRecord>('settings', 'model-profile') ?? { provider: 'vercel-ai-gateway', modelId: 'anthropic/claude-sonnet-4.5' };
    this.requestBudgets = new RequestBudgetAuthority(store, { task: (id) => this.getTask(id),
      replace: (task) => { this.tasks.set(task.id, task); this.publish(); },
      completion: (id) => {
        const task = this.getTask(id); const execution = this.execution[id];
        const operations = [...this.operations.values()].filter((operation) => operation.taskId === id);
        return { answered: task.status === 'answered' && !task.resumeReason,
          unresolved: operations.some((operation) => operationNeedsVerification(operation)
            || (['proposed', 'approved', 'running', 'unknown'].includes(operation.status) && !operation.reconciledAt)),
          reportPending: task.resumeReason === 'report' || (task.verificationState?.status === 'unverified' && !task.report),
          modelIdle: execution?.model === 'idle', remoteIdle: execution?.remote === 'idle' };
      } });
    store.cleanupLogs();
    this.retentionTimer = setInterval(() => store.cleanupLogs(), 24 * 60 * 60_000);
  }

  /** Use the existing sending coordinator's live job map, not a second queue. */
  setBudgetPreparationAuthority(active: (requestId: string, taskId?: string) => boolean, revalidate?: () => void): void {
    this.budgetPreparationActive = active; this.revalidatePreparations = revalidate;
  }

  requestBudget(input: unknown): import('@cloudhelm/contracts').BudgetOutcome {
    if (this.closed) return { error: 'budget-unavailable' };
    return createBudgetRequestHandler(this.requestBudgets, (command) => {
      if (command.kind === 'summary') {
        const receipt = this.store.get<{ state: string; conversationId?: string }>('message-receipts', command.requestId);
        if (!this.budgetPreparationActive(command.requestId) || receipt?.state !== 'preparing') throw new Error('Preparation unavailable');
        if (receipt.conversationId) this.getTask(receipt.conversationId);
      } else {
        const task = this.getTask(command.taskId);
        if (command.kind === 'reserve' && command.preparationId !== undefined) {
          const receipt = this.store.get<{ state: string; conversationId?: string }>('message-receipts', command.preparationId);
          const execution = this.execution[task.id];
          if (command.attempt.purpose !== 'compaction' || !this.budgetPreparationActive(command.preparationId, task.id)
            || receipt?.state !== 'preparing' || receipt.conversationId !== task.id
            || execution?.remote !== 'idle' || execution.stopping) throw new Error('Compaction preparation unavailable');
        }
        if (command.kind === 'review') {
          const operation = this.operations.get(command.operationId);
          if (!['running', 'waiting-review'].includes(task.status) || operation?.taskId !== task.id
            || operation.status !== 'proposed' || operation.reconciledAt) throw new Error('Review scope unavailable');
        }
      }
    })(input);
  }

  snapshot(): AppSnapshot {
    return {
      runtimeResources: this.store.list('runtime-resources'),
      reasoningProgress: { ...this.reasoningProgress }, execution: { ...this.execution }, contextUsage: { ...this.contextUsage }, contextCompaction: { ...this.contextCompaction },
      hosts: [...this.hosts.values()], terminals: [...this.terminals.values()], conversations: [...this.tasks.values()], operations: [...this.operations.values()],
      clarifications: [...this.clarifications.values()],
      approvals: [...this.approvals.values()], inputs: [...this.inputs.values()], messages: [...this.messages],
      profile: { ...this.profile, hasKey: !!this.profileSecret(), hasJevKey: !!this.secret('jev-key:vercel-ai-gateway'), reviewer: this.reviewerSettings().selection }
    };
  }

  addHost(draft: HostDraft): HostView {
    if (!Value.Check(HostDraftSchema, draft)) throw new Error('Invalid host settings');
    if (draft.jumpHostId && (!this.hosts.has(draft.jumpHostId) || this.getHost(draft.jumpHostId).archived
      || this.getHost(draft.jumpHostId).jumpHostId)) {
      throw new Error('Choose an existing direct SSH host as the single jump host');
    }
    const host: HostView = { ...draft, id: randomUUID(), status: 'disconnected', protectedPaths: [],
      protectedReadPaths: [], protectedWritePaths: [], defaultMode: 'ask', policyRevision: 1, sudoCachePolicy: { mode: 'disabled', revision: 1 } };
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
      || previous.runtimeDirectory !== draft.runtimeDirectory
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
      sudoCachePolicy: { mode: 'disabled', revision: 1 },
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

  /** Conversations with live work stay until the user finishes them first. */
  /** Runs before restoring host locks. No in-memory capability changes until
   * operation patches, affected tasks and repair receipts commit together. */
  async normalizeHistoricalQueries(analyzer: CommandAnalyzer): Promise<void> {
    const current = () => ({ operations: [...this.operations.values()], tasks: [...this.tasks.values()], hosts: [...this.hosts.values()] });
    const before = structuredClone(current());
    const baselines = ['operations', 'tasks', 'hosts'].map((bucket) => ({ bucket, values: this.store.list(bucket) }));
    const repair = await planHistoricalQueryRepair(before, analyzer);
    if (!repair.operations.length) return;
    if (JSON.stringify(current()) !== JSON.stringify(before)) throw new Error('历史修复期间状态发生变化，请重新读取后重试');
    this.store.commitDataRepair({ ...HISTORICAL_QUERY_REPAIR, baselines,
      recordIds: repair.operations.map((operation) => operation.id), changes: [
        ...repair.operations.map((value) => ({ bucket: 'operations', id: value.id, value })),
        ...repair.tasks.map((value) => ({ bucket: 'tasks', id: value.id, value }))
      ] });
    for (const operation of repair.operations) this.operations.set(operation.id, operation);
    for (const task of repair.tasks) this.tasks.set(task.id, task);
  }

  assertDeletable(id: string): TaskView {
    const task = this.getTask(id);
    if (isActiveTaskStatus(task.status) || this.execution[id]?.canStop || this.execution[id]?.stopping) throw new Error('对话仍在进行中，请先停止或等待结束后再删除');
    if ([...this.operations.values()].some((op) => op.taskId === id && operationNeedsVerification(op))) {
      throw new Error('远端结果尚未核验，请先保留操作记录并确认结果后再删除');
    }
    return task;
  }

  /** Explicit data-only report refresh. Never restore a runner, connect SSH or request model budget. */
  async rebuildVerificationReport(id: string, analyzer: CommandAnalyzer): Promise<void> {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('无效对话编号。');
    const task = structuredClone(this.getTask(id));
    const owned = () => [...this.operations.values()].filter((op) => op.taskId === id);
    const busy = () => this.execution[id]?.model === 'running' || this.execution[id]?.remote === 'running';
    if (busy()) throw new Error('任务尚未空闲，不能重新整理。');
    const baseline = JSON.stringify([task, owned()]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now(); const expired = () => new Error('整理已有记录超时；未修改报告，也未执行命令。');
    const report = await Promise.race([rebuildRecordedVerification(task, structuredClone(owned()), analyzer), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(expired()), 5000);
    })]).finally(() => { if (timer) clearTimeout(timer); });
    if (Date.now() - started >= 5000) throw expired();
    if (JSON.stringify([this.getTask(id), owned()]) !== baseline || busy()) throw new Error('整理期间记录已变化，未保存；请重新查看。');
    const reason = verificationReason(report);
    if (JSON.stringify(report) !== JSON.stringify(task.report)) this.record({ type: 'work-report', taskId: id, report });
    this.record({ type: 'verification-state', taskId: id, value: { status: reason ? 'unverified' : 'verified',
      operationIds: [...new Set([...report.facts!.operations.filter((op) => op.status === 'succeeded' && op.readOnly !== true).map((op) => op.operationId),
        ...report.facts!.riskOperationIds])], ...(reason ? { reasonCode: reason } : {}) } });
  }

  /** Permanently removes a finished conversation, its records and its terminal logs. */
  deleteTask(id: string): void {
    this.assertDeletable(id);
    const logKeys = new Set<string>();
    for (const operation of this.operations.values()) {
      if (operation.taskId !== id) continue;
      logKeys.add(`operation:${operation.id}`);
      if (operation.logRef) logKeys.add(operation.logRef);
    }
    for (const terminal of this.terminals.values()) if (terminal.taskId === id) logKeys.add(terminal.id);
    this.flushLogs();
    for (const message of this.messages.filter((message) => message.taskId === id)) {
      for (const part of message.document?.parts ?? []) if (part.type === 'reference') this.store.removeReference(part.reference.id);
    }
    this.store.removeWhere('message-receipts', 'conversationId', id);
    this.tasks.delete(id);
    for (const [key, operation] of [...this.operations]) if (operation.taskId === id) this.operations.delete(key);
    for (const [key, approval] of [...this.approvals]) if (approval.taskId === id) this.approvals.delete(key);
    for (const [key, input] of [...this.inputs]) if (input.taskId === id) this.inputs.delete(key);
    for (const [key, request] of [...this.clarifications]) if (request.taskId === id) this.clarifications.delete(key);
    for (let index = this.messages.length - 1; index >= 0; index--) if (this.messages[index]!.taskId === id) this.messages.splice(index, 1);
    for (const [key, terminal] of [...this.terminals]) {
      if (terminal.taskId !== id) continue;
      this.terminals.delete(key);
      this.redactors.delete(key);
      this.logBuffer.delete(key);
    }
    this.store.remove('tasks', id);
    this.store.removeWhere('operations', 'taskId', id);
    this.store.removeWhere('messages', 'taskId', id);
    this.store.removeWhere('clarifications', 'taskId', id);
    this.store.removeWhere('verification-reports', 'taskId', id);
    this.store.removePrefix('model-requests', `${id}:`);
    delete this.reasoningProgress[id];
    delete this.execution[id];
    delete this.contextUsage[id];
    delete this.contextCompaction[id];
    for (const key of logKeys) this.store.removeLogs(key);
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

  saveProfile(draft: ModelProfileDraft): void {
    const provider = listModelProviders().find((candidate) => candidate.id === draft.provider);
    if (!provider) throw new Error('Choose a Pi model provider');
    const modelId = draft.modelId.trim();
    if (!modelId || (provider.id !== 'cloudhelm-custom' && !provider.models.some((model) => model.id === modelId))) {
      throw new Error('Choose a model from the selected Pi provider');
    }
    const requestedUrl = draft.baseUrl?.trim();
    if (provider.id === 'cloudhelm-custom' && !requestedUrl) throw new Error('Custom model URL is required');
    const baseUrl = requestedUrl && requestedUrl !== provider.defaultBaseUrl ? validModelUrl(requestedUrl) : undefined;
    const limits = provider.id === 'cloudhelm-custom' ? customModelLimits(draft) : undefined;
    if (!limits && (draft.contextWindow !== undefined || draft.maxTokens !== undefined)) throw new Error('内置模型容量由 Pi 模型目录提供');
    const legacyKey = this.sameProfileProvider(provider.id, provider.name) ? this.profileSecret() : undefined;
    const previous = this.store.get<ProfileRecord>('settings', `model-provider:${provider.id}`);
    const savedKey = this.secret(this.modelSecretId(provider.id));
    const previousKey = savedKey ?? legacyKey;
    const keyToSave = draft.apiKey || (!savedKey ? legacyKey : undefined);
    // Encrypt before changing defaults: OS keychain failure must leave the prior profile intact.
    const ciphertext = keyToSave ? this.encryptSecret(keyToSave) : undefined;
    const credentialRevision = previous?.credentialRevision && previous.baseUrl === baseUrl
      && previous.contextWindow === limits?.contextWindow && previous.maxTokens === limits?.maxTokens
      && (!draft.apiKey || draft.apiKey === previousKey) ? previous.credentialRevision : randomUUID();
    this.profile = { provider: provider.id, modelId, baseUrl, ...limits, credentialRevision };
    this.store.put('settings', 'model-profile', this.profile);
    this.store.put('settings', `model-provider:${provider.id}`, { modelId, baseUrl, ...limits, credentialRevision });
    if (ciphertext) this.store.put('secrets', this.modelSecretId(provider.id), ciphertext);
    this.publish();
  }

  saveReviewSettings(settings: { jevKey?: string; disableJev?: boolean; reviewer?: ReviewSelection }): void {
    if (!settings || typeof settings !== 'object' || (settings.jevKey !== undefined && typeof settings.jevKey !== 'string')
      || (settings.disableJev !== undefined && typeof settings.disableJev !== 'boolean')) throw new Error('审核设置无效');
    const selection = settings.reviewer ?? this.reviewerSettings().selection;
    if (!selection || typeof selection !== 'object' || !['current', 'jev', 'model'].includes(selection.kind)
      || (selection.kind === 'model' && (!selection.provider?.trim() || !selection.modelId?.trim()))) {
      throw new Error('审核模型选择无效');
    }
    if (selection.kind === 'jev' && settings.disableJev) throw new Error('选择 Jev 审核时不能删除 Jev Key');
    if (selection.kind === 'model') this.plainRuntimeProfile(selection);
    if (selection.kind === 'jev' && !settings.jevKey && !this.reviewKey()) throw new Error('请先配置 Jev Key');
    if (settings.jevKey) this.saveSecret('jev-key:vercel-ai-gateway', settings.jevKey);
    if (settings.disableJev) this.store.remove('secrets', 'jev-key:vercel-ai-gateway');
    const previous = this.reviewerSettings();
    this.store.put('settings', 'reviewer', { selection, revision: previous.revision + 1 } satisfies StoredReviewer);
    this.publish();
  }

  reviewKey(): string | undefined { return this.secret('jev-key:vercel-ai-gateway'); }

  reviewerSettings(): StoredReviewer {
    return this.store.get<StoredReviewer>('settings', 'reviewer') ?? { selection: { kind: 'current' }, revision: 1 };
  }

  /** Shortcut preferences are local UI state; unknown action ids are dropped on read. */
  shortcuts(): StoredShortcuts {
    const stored = this.store.get<Partial<StoredShortcuts>>('settings', 'shortcuts');
    if (!stored || typeof stored !== 'object') return { bindings: {}, enabled: true };
    return { bindings: validBindings(stored.bindings), enabled: stored.enabled !== false };
  }

  saveShortcuts(settings: StoredShortcuts): void {
    if (!settings || typeof settings !== 'object') throw new Error('Invalid shortcut settings');
    const bindings = validBindings(settings.bindings);
    if (Object.keys(bindings).length !== Object.keys(settings.bindings ?? {}).length) throw new Error('Invalid shortcut bindings');
    this.store.put('settings', 'shortcuts', { bindings, enabled: settings.enabled !== false });
  }

  runtimeProfile(selection?: ModelChoice & { baseUrl?: string }): RuntimeProfile {
    const profile = this.plainRuntimeProfile(selection);
    return { ...profile, reviewer: this.runtimeReviewer(profile), jevKey: this.reviewKey() };
  }

  private plainRuntimeProfile(selection?: ModelChoice & { baseUrl?: string }): RuntimeProfile {
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
      ...(provider.id === 'cloudhelm-custom' ? customModelLimits({ ...choice,
        contextWindow: saved.contextWindow, maxTokens: saved.maxTokens }) : {}),
      credentialRevision: binding.credentialRevision };
  }

  runtimeReviewer(current: RuntimeProfile): RuntimeReviewProfile {
    const { selection, revision } = this.reviewerSettings();
    if (selection.kind === 'jev') return { selection, provider: 'vercel-ai-gateway', modelId: 'typesafe-ai/jev',
      apiKey: this.reviewKey(), revision };
    const profile = selection.kind === 'current' ? current : this.plainRuntimeProfile(selection);
    return { selection, provider: profile.provider, modelId: profile.modelId, baseUrl: profile.baseUrl,
      apiKey: profile.apiKey, revision };
  }

  runtimeReviewerForLiveTask(task: TaskView): RuntimeReviewProfile {
    const { selection, revision } = this.reviewerSettings();
    if (selection.kind === 'current') return { selection, provider: task.provider ?? '', modelId: task.modelId,
      revision };
    return this.runtimeReviewer({ provider: '', modelId: '', apiKey: '' });
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
    const limits = provider.id === 'cloudhelm-custom' ? customModelLimits(draft) : undefined;
    if (!limits && (draft.contextWindow !== undefined || draft.maxTokens !== undefined)) throw new Error('内置模型容量由 Pi 模型目录提供');
    return { provider: draft.provider, modelId: draft.modelId, apiKey,
      baseUrl: draft.baseUrl ? validModelUrl(draft.baseUrl) : undefined, ...limits };
  }

  availableModels(): Array<ModelChoice & { name: string; thinkingLevels?: import('@cloudhelm/contracts').ThinkingLevel[] }> {
    return listModelProviders().flatMap((provider) => {
      const settings = this.modelProviderSettings(provider.id);
      if (!settings.hasKey) return [];
      const models = provider.id === 'cloudhelm-custom' && settings.modelId
        ? [{ id: settings.modelId, name: settings.modelId }] : provider.models;
      return models.map((model) => ({ provider: provider.id, modelId: model.id, name: model.name, thinkingLevels: modelThinking({ provider: provider.id, modelId: model.id, baseUrl: settings.baseUrl,
        contextWindow: settings.contextWindow, maxTokens: settings.maxTokens }).levels }));
    });
  }

  setTaskModel(id: string, profile: RuntimeProfile, live = false): void {
    const task = this.getTask(id);
    delete this.contextUsage[id];
    if (!live) {
      const choice = modelThinking(profile, task.thinking?.selected);
      task.thinking = { ...choice, effective: task.thinking?.effective ?? choice.selected, pending: true };
    }
    Object.assign(task, { provider: profile.provider, modelId: profile.modelId, baseUrl: profile.baseUrl,
      contextWindow: profile.contextWindow, maxTokens: profile.maxTokens,
      credentialRevision: profile.credentialRevision, updatedAt: Date.now() });
    this.store.put('tasks', id, task);
    this.publish();
  }

  archiveHost(id: string): void { this.updateHost(id, { archived: true, status: 'disconnected' }); }

  modelProviderSettings(providerId: string): ModelProviderSettings {
    const provider = listModelProviders().find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error('Unknown Pi model provider');
    const saved = this.store.get<Pick<ProfileRecord, 'modelId' | 'baseUrl' | 'contextWindow' | 'maxTokens'>>('settings', `model-provider:${providerId}`);
    const active = this.sameProfileProvider(provider.id, provider.name) ? this.profile : undefined;
    const legacyKey = active ? this.secret(this.legacyModelSecretId(active)) : undefined;
    return {
      modelId: saved?.modelId ?? active?.modelId,
      baseUrl: saved?.baseUrl ?? active?.baseUrl,
      contextWindow: saved?.contextWindow ?? active?.contextWindow,
      maxTokens: saved?.maxTokens ?? active?.maxTokens,
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

  /**
   * Persists an explicit user risk acceptance. The remote outcome stays unknown:
   * this only records that the user took over the risk so the write lock can be
   * released. Callers re-arm the write lock when this throws.
   */
  acceptOperationRisk(operationId: string, explanation: string, at: number, sourceTaskId?: string, evidenceOperationIds?: string[]): OperationView {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error('未找到该操作');
    if (operation.reconciledAt) {
      if (operation.reconciliation?.kind === 'risk-accepted' && operation.reconciliation.at === at) return structuredClone(operation);
      throw new Error('该操作已经核验或确认，不能重复解除');
    }
    if (!operationOutcomeResolvable(operation)) throw new Error('该操作没有可确认的未知结果');
    const updated: OperationView = { ...operation, reconciledAt: at,
      reconciliation: { kind: 'risk-accepted', explanation, at, sourceTaskId, evidenceOperationIds } };
    this.store.put('operations', operationId, updated);
    this.operations.set(operationId, updated);
    this.publish();
    return structuredClone(updated);
  }

  createTask(goal: string, hostIds: string[], modelId: string, localScopes: LocalScope[]): TaskView {
    const authorized = [...new Set(hostIds)];
    if (!goal.trim() || authorized.some((id) => !this.hosts.has(id))) throw new Error('Describe a goal and select valid hosts');
    const now = Date.now();
    const task: TaskView = {
      id: randomUUID(), goal: goal.trim(), hostIds: authorized,
      reviewModesByHost: Object.fromEntries(authorized.map((id) => [id, this.getHost(id).defaultMode])), reviewRevision: 1,
      localScopes, status: 'draft', modelId, provider: this.profile.provider, baseUrl: this.profile.baseUrl,
      requestCount: 0, requestLimit: 100, budget: createRequestBudget(randomUUID()), createdAt: now, updatedAt: now
    };
    task.session = { version: 1, id: task.id };
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
    const modes = { ...task.reviewModesByHost };
    for (const id of authorized) modes[id] ??= this.getHost(id).defaultMode;
    const updated = { ...task, hostIds: authorized, reviewModesByHost: modes, localScopes: scopes, updatedAt: Date.now() };
    this.tasks.set(taskId, updated);
    this.store.put('tasks', taskId, updated);
    this.publish();
  }

  updateConversationReviewMode(taskId: string, hostId: string, mode: ReviewMode): TaskView {
    const task = this.getTask(taskId);
    if (!task.hostIds.includes(hostId)) throw new Error('主机不属于当前对话');
    const updated: TaskView = { ...task, reviewModesByHost: { ...task.reviewModesByHost, [hostId]: mode },
      reviewRevision: (task.reviewRevision ?? 1) + 1, updatedAt: Date.now() };
    this.tasks.set(taskId, updated);
    this.store.put('tasks', taskId, updated);
    this.publish();
    return updated;
  }

  record(event: AppEvent | { type: 'approval-open'; value: AppSnapshot['approvals'][number] }
    | { type: 'approval-close'; id: string } | { type: 'operation'; value: OperationView }
    | { type: 'input-open'; value: InputRequestView } | { type: 'input-close'; id: string }
    | { type: 'task-status'; taskId: string; status: TaskView['status']; summary?: string; resumeReason?: ResumeReason; requestCount?: number }
    | { type: 'host-status'; hostId: string; status: HostView['status'] }): void {
    if (this.closed) return;
    switch (event.type) {
      case 'operation': {
        const operation = retainOperationResolution(this.operations.get(event.value.id), event.value);
        if (operation.logRef && ['succeeded', 'failed'].includes(operation.status)) {
          const id = operation.logRef;
          const tail = this.redactors.get(id)?.finish() ?? '';
          this.redactors.delete(id);
          this.logBuffer.set(id, (this.logBuffer.get(id) ?? '') + tail);
          const key = `operation:${operation.id}`;
          this.logBuffer.set(key, (this.logBuffer.get(key) ?? '') + tail);
        }
        this.store.put('operations', operation.id, operation);
        this.operations.set(operation.id, operation);
        break;
      }
      case 'clarification':
        this.clarifications.set(event.value.id, event.value);
        this.store.put('clarifications', event.value.id, event.value);
        break;
      case 'approval-open': this.approvals.set(event.value.id, event.value); break;
      case 'approval-close': this.approvals.delete(event.id); break;
      case 'input-open': this.inputs.set(event.value.id, event.value); break;
      case 'input-close': this.inputs.delete(event.id); break;
      case 'host-status': this.updateHost(event.hostId, { status: event.status }); break;
      case 'task-status': {
        const task = this.tasks.get(event.taskId);
        if (task) {
          Object.assign(task, { status: event.status, updatedAt: Date.now(), summary: event.summary ?? (['running', 'answered'].includes(event.status) ? undefined : task.summary), resumeReason: event.resumeReason, requestCount: task.budget?.totalUsed ?? task.requestCount });
          this.store.put('tasks', task.id, task);
        }
        break;
      }
      case 'task-intent': {
        if (!Value.Check(TaskIntentStateSchema, event.value)) throw new Error('任务意图记录无效');
        const task = this.getTask(event.taskId);
        if (task.intent && event.value.revision < task.intent.revision) return;
        if (task.intent && event.value.revision === task.intent.revision) {
          if (JSON.stringify(task.intent) !== JSON.stringify(event.value)) throw new Error('任务意图版本冲突');
          return;
        }
        const updated = { ...task, intent: structuredClone(event.value) };
        this.store.put('tasks', task.id, updated);
        this.tasks.set(task.id, updated);
        break;
      }
      case 'task-message': {
        const existing = event.entryId ? this.messages.find((message) => message.taskId === event.taskId && message.entryId === event.entryId) : undefined;
        const source = event.source ?? existing?.source;
        const clarificationToolCallId = event.clarificationToolCallId ?? existing?.clarificationToolCallId;
        if (existing && (!event.reasoning || JSON.stringify(existing.reasoning) === JSON.stringify(event.reasoning))
          && existing.source === source && existing.clarificationToolCallId === clarificationToolCallId) return;
        const message = { document: event.document ?? existing?.document, entryId: event.entryId, taskId: event.taskId,
          role: event.role, source, clarificationToolCallId, text: event.text, reasoning: event.reasoning ?? existing?.reasoning,
          createdAt: event.createdAt, model: event.model, interruption: event.interruption };
        if (existing) Object.assign(existing, message); else this.messages.push(message);
        if (event.role === 'agent') delete this.reasoningProgress[event.taskId];
        this.store.put('messages', event.entryId ? `${event.taskId}:${event.entryId}` : `${event.createdAt}:${randomUUID()}`, message);
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
        else this.terminals.set(event.terminalId, { ...this.terminals.get(event.terminalId), id: event.terminalId, hostId: event.hostId, taskId: event.taskId, state: event.state });
        if (event.state === 'closed') {
          const tail = this.redactors.get(event.terminalId)?.finish() ?? '';
          this.logBuffer.set(event.terminalId, (this.logBuffer.get(event.terminalId) ?? '') + tail);
          this.redactors.delete(event.terminalId);
          this.flushLogs();
        }
        break;
      }
      case 'terminal-replaced': {
        const previous = this.terminals.get(event.previousTerminalId);
        const replacement = this.terminals.get(event.terminalId);
        if (previous && replacement && previous.taskId === replacement.taskId && previous.hostId === replacement.hostId) {
          previous.replacementTerminalId = replacement.id;
        }
        break;
      }
      case 'context-compaction':
        if (this.tasks.has(event.taskId)) this.contextCompaction[event.taskId] = event.status;
        break;
      case 'reasoning-progress':
        if (!this.tasks.has(event.taskId)) return;
        if (event.value) this.reasoningProgress[event.taskId] = event.value;
        else delete this.reasoningProgress[event.taskId];
        break;
      case 'thinking': {
        const task = this.getTask(event.taskId);
        task.thinking = event.value;
        this.store.put('tasks', task.id, task);
        break;
      }
      case 'execution':
        if (this.tasks.has(event.taskId)) this.execution[event.taskId] = event.value;
        break;
      case 'context-usage':
        if (this.tasks.has(event.taskId)) this.contextUsage[event.taskId] = event.value;
        break;
      case 'model-request':
        this.store.put('model-requests', `${event.taskId}:${event.request}`, event);
        break;
      case 'work-progress':
      case 'work-report':
      case 'verification-state':
      case 'verification-round': {
        const task = this.getTask(event.taskId);
        if (event.type === 'work-progress') task.plan = event.plan;
        else if (event.type === 'work-report') recordVerificationReport(this.store, task, event.report);
        else if (event.type === 'verification-round') task.verificationRound = event.value;
        else task.verificationState = event.value;
        this.store.put('tasks', task.id, task);
        break;
      }
      case 'snapshot': break;
    }
    if (event.type !== 'terminal-data') this.publish();
    if (event.type === 'message-preparation' || event.type === 'terminal-data' || event.type === 'terminal-state' || event.type === 'terminal-replaced' || event.type === 'task-message' || event.type === 'model-request') this.emit(event);
  }

  publish(): void {
    if (this.closed) return;
    // Revoke preparing capabilities before publishing a changed configuration or
    // returning a pending budget acknowledgment; no additional job registry.
    this.revalidatePreparations?.();
    this.emit({ type: 'snapshot', value: this.snapshot() });
  }

  runtimeStopped(): void {
    for (const value of Object.values(this.reasoningProgress)) value.reasoning = { ...value.reasoning, status: 'interrupted' };
    for (const [id, value] of Object.entries(this.execution)) this.execution[id] = {
      model: 'idle', remote: value.remote === 'idle' ? 'idle' : 'unknown', stopping: false, canStop: false
    };
    for (const id of Object.keys(this.contextUsage)) delete this.contextUsage[id];
    for (const id of Object.keys(this.contextCompaction)) delete this.contextCompaction[id];
    if (this.closed) return;
    for (const host of this.hosts.values()) if (host.status === 'connected' || host.status === 'connecting') {
      this.updateHost(host.id, { status: 'disconnected' });
    }
    for (const terminal of this.terminals.values()) this.record({ type: 'terminal-state', terminalId: terminal.id,
      hostId: terminal.hostId, taskId: terminal.taskId, state: 'closed' });
    for (const operation of this.operations.values()) if (['running', 'approved'].includes(operation.status)) {
      this.record({ type: 'operation', value: { ...operation, status: 'unknown', reason: '运行进程退出，远端结果待核验。' } });
    }
    for (const task of this.tasks.values()) if (task.session && ['running', 'waiting-review', 'human-control', 'paused'].includes(task.status)) {
      this.record({ type: 'task-status', taskId: task.id, status: 'recovering', summary: '运行进程已停止，请重新打开 CloudHelm 后核验远端状态。' });
    }
    for (const request of this.clarifications.values()) if (request.status === 'pending') {
      this.record({ type: 'clarification', value: { ...request, status: 'expired' } });
      this.record({ type: 'task-status', taskId: request.taskId, status: 'paused', summary: '运行进程已退出，旧问题已失效。请重新发送需求。' });
    }
    this.approvals.clear(); this.inputs.clear(); this.publish();
  }

  close(): void {
    if (this.closed) return;
    if (this.logFlushTimer) clearTimeout(this.logFlushTimer);
    clearInterval(this.retentionTimer);
    for (const [id, redactor] of this.redactors) {
      this.logBuffer.set(id, (this.logBuffer.get(id) ?? '') + redactor.finish());
    }
    this.redactors.clear();
    this.flushLogs();
    this.closed = true;
  }

  private flushLogs(): void {
    if (this.closed) return;
    if (this.logFlushTimer) clearTimeout(this.logFlushTimer);
    this.logFlushTimer = undefined;
    for (const [id, data] of this.logBuffer) if (data) this.store.appendLog(id, data);
    this.logBuffer.clear();
  }
}
