import { bindCommandExecutionPlan, taskOperationScope } from './task-operation-scope.js';
import { applyOperationCompletion } from './operation-completion.js';
import { applyOperationDecision } from './operation-decision.js';
import { operationPreview } from './operation-preview.js';
import type { FileApprovalPreview } from '@cloudhelm/core';
import { blockedOperationFeedback, operationToolResult } from './operation-feedback.js';
import { decideTaskCompletion } from './task-completion.js';
import { VerificationRoundTracker } from './verification-round.js';
import { verificationSource } from './verification-source.js';
import { randomUUID } from 'node:crypto';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import { ClarificationCoordinator, SafetyGate, type TerminalManager } from '@cloudhelm/application';
import { AiRiskEvaluator, BashAnalyzer, createConversationSession } from '@cloudhelm/adapters';
import { createTaskReviewer, resolveTaskReviewer } from './task-review-client.js';
import { taskSessionEvents } from './task-session-events.js';
import type { TaskSignals } from './task-signals.js';
export type { TaskSignals } from './task-signals.js';
import { TaskRequestBudget } from './task-request-budget.js';
import { taskPreparation, assertPreparedInput, type PreparationSnapshot } from './task-preparation.js';
import { authorizeTaskInput } from './task-input-authorization.js';
import { interruptionContext } from './task-input-context.js';
import { taskContextSnapshot } from './task-context.js';
import { TaskProgress } from './task-progress.js';
import { observeProgressTools } from './task-progress-observer.js';
import { RequestBudgetError, PrivilegeError, privilegeGuidance } from '@cloudhelm/core';
import { operationIntentKey, isReadOnlyQuery, isSudoStatusProbe, safeDiagnostic, serialCall, type ConversationSession, type SessionStorage, type DiagnosticEvent, redactOutput, type OperationAudit, type OperationResult, type OperationExecutor, type OperationScope, type ProposedOperation, type SafetyDecision, type ScriptInspector } from '@cloudhelm/core';
import type { OperationView, InterruptionSource, UserInterruption, ReviewMode, ResumeReason, TaskStatus, TaskView } from '@cloudhelm/contracts';
import { isActiveTaskStatus, operationNeedsVerification, operationOutcomeResolvable } from '@cloudhelm/contracts';
import type { LocalScope } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import { recoveryContextMessage } from './recovery-context.js';
import { mergeOperationViews } from './runtime-facts.js';
import { applyCommittedRiskAcceptance } from './risk-acceptance.js';
import { deriveInputIntent, TaskIntent } from './task-intent.js';
import { createRemoteTools } from './remote-tools.js';
import { createTaskPrompt } from './task-prompt.js';
import { FilePreviewPublisher } from './file-preview-publisher.js';
import { approvalView } from './approval-view.js';
import { inputPlan } from './operation-input-plan.js';
import { WorkJournal } from './work-journal.js';
import { LocalFileAccess } from './local-file-access.js';

export class TaskRunner {
  private readonly filePreviews = new FilePreviewPublisher((value) => this.signals.filePreview?.(value));
  private readonly clarification: ClarificationCoordinator;
  private profile: RuntimeProfile;
  private readonly journal: WorkJournal;
  private readonly verification: VerificationRoundTracker;
  private controlVersion = 0;
  private resuming?: { version: number; promise: Promise<void> };
  private readonly intent: TaskIntent;
  private readonly localFiles: LocalFileAccess;
  private readonly analyzer = new BashAnalyzer();
  private agent?: ConversationSession;
  private readonly budget: TaskRequestBudget;
  private requestCount = 0;
  private requestStarted = 0;
  private readonly progress = new TaskProgress();
  private needsRecovery = false;
  private pendingInterruption?: UserInterruption;
  private lastFailureKey = '';
  private sameFailureCount = 0;
  private consecutiveAiDenials = 0;
  private readonly aiDeniedOperations = new Map<string, ProposedOperation>();
  private readonly manualReviewsInFlight = new Set<string>();
  private remoteBlocked?: string;
  private readonly operations = new Map<string, OperationView>();
  private readonly proposedOperations = new Map<string, ProposedOperation>();
  private readonly terminalByHost = new Map<string, string>();
  private readonly openingTerminals = new Map<string, Promise<string>>();
  private readonly replayProtected = new Set<string>();
  private stopping = false;
  private cleanupPromise?: Promise<void>;
  private status: TaskStatus = 'draft';
  private resumeReason?: ResumeReason;
  /** One remote operation at a time: a queued call re-checks activity after the previous finishes. */
  private readonly runOperation = serialCall((gate: SafetyGate, operation: ProposedOperation,
    signal: AbortSignal | undefined, hostLabel: string, manualReview: boolean = false) =>
    this.performOperation(gate, operation, signal, hostLabel, manualReview));

  constructor(
    readonly task: TaskView,
    private readonly hosts: RuntimeHost[],
    profile: RuntimeProfile,
    private readonly priorOperations: OperationView[],
    private readonly terminal: TerminalManager,
    private readonly executor: OperationExecutor,
    private readonly openTerminal: (hostId: string, taskId: string) => Promise<string>,
    private readonly signals: TaskSignals,
    private readonly readLog: (operationId: string, cursor: number) => Promise<{ text: string; nextCursor: number; more: boolean }> = async () => ({ text: '', nextCursor: 0, more: false }),
    private readonly privileged?: PrivilegedTaskAccess,
    private readonly storage?: SessionStorage,
    private readonly scripts?: ScriptInspector,
    private readonly prepareRemote?: (operation: ProposedOperation, gate: SafetyGate, signal?: AbortSignal) => Promise<{ operation: ProposedOperation; preview?: FileApprovalPreview }>
  ) {
    this.intent = new TaskIntent(task, (value) => signals.event({ type: 'task-intent', taskId: task.id, value }));
    const pendingReport = task.resumeReason === 'report' || (task.verificationState?.status === 'unverified' && !task.report);
    this.resumeReason = task.resumeReason ?? (pendingReport ? 'report' : undefined);
    this.verification = new VerificationRoundTracker(task, this.operationViews(), signals.event);
    for (const operation of priorOperations) this.replayProtected.add(operation.id);
    this.clarification = new ClarificationCoordinator(task.id, (request) => {
      if (request.status === 'answered') { this.intent.clarify(request); this.progress.observe('clarification', request.id); }
      this.signals.event({ type: 'clarification', value: request });
      if (request.status === 'pending') this.setStatus('waiting-user');
      if (request.status === 'answered') this.setStatus('running');
    }, () => { this.setStatus('paused', '需求澄清已停止，AI 不会猜测回答或自动继续。'); this.agent?.abort(); });
    this.profile = profile;
    this.requestCount = task.requestCount;
    this.budget = new TaskRequestBudget(task.id, signals.budget);
    this.journal = new WorkJournal(task.id, () => this.operationViews(), signals.event, this.readLog,
      (operation) => this.executor.reconcile?.(operation.hostId, operation.id) ?? false, (operation) => {
      this.operations.set(operation.id, operation);
      this.progress.observe('resolution', JSON.stringify([operation.id, operation.reconciliation?.kind]));
      this.signals.event({ type: 'operation', value: operation });
      this.publishExecution();
    }, () => this.verificationOperations(), () => this.verification.id, task.report);
    this.localFiles = new LocalFileAccess(task.localScopes ?? []);
  }

  private async initializeSession(thinkingLevel?: import('@cloudhelm/core').ThinkingLevel): Promise<void> {
    const gate = this.createGate();
    const remoteTools = createRemoteTools({ hosts: this.hosts, localFiles: this.localFiles,
      ensureTerminal: async (id, sessionId) => {
        this.assertRemoteActive();
        if (sessionId) {
          if (!this.privileged) throw new Error('Root sessions unavailable');
          return this.privileged.terminal(sessionId, id);
        }
        return this.ensureTerminal(id);
      },
      requestRoot: async (host, command, cwd, reason, signal, method) => {
        this.assertRemoteActive();
        if (!this.privileged) throw new Error('Root sessions unavailable');
        try { return await this.privileged.request(host, command, cwd, reason, this.intent.goal(), gate, signal, this.intent.snapshot(), method, 'execute', { conversationRevision: this.task.reviewRevision ?? 1, reviewerRevision: this.profile.reviewer?.revision ?? 1 }); }
        catch (error) { this.blockRemote(error instanceof PrivilegeError ? privilegeGuidance(error.feedback) : '提权上下文未建立；直接su通常需要root密码而非sudo密码。请处理后点击继续AI或明确发送下一步指令。', false, 'interrupted'); throw error; }
      }, scope: (host, id, cwd) => this.scope(host, id, cwd),
      runOperation: (gate, operation, signal, label) => this.runOperation(gate, operation, signal, label) }, gate);
    const currentSystemPrompt = createTaskPrompt(this.task, this.hosts, () => this.operationViews(), () => this.verificationOperations(), this.privileged, () => this.journal.hasReport(), () => this.intent.snapshot(), () => this.journal.submissionClosed());
    this.agent = await createConversationSession({
      thinkingLevel, profile: this.profile, storage: this.storage,
      systemPrompt: currentSystemPrompt(), currentSystemPrompt,
      tools: observeProgressTools([...remoteTools, ...this.journal.tools()], this.progress, () => this.operationViews()),
      clarification: { ask: (id, questions, signal) => {
        this.assertRemoteActive();
        return this.clarification.ask(id, questions, signal);
      } },
      assertActive: () => this.assertRemoteActive(),
      requestGeneration: () => this.requestGeneration(),
      beforeRequest: async (purpose, profile, attempt, signal) => {
        this.assertRemoteActive();
        if (this.progress.stalled) {
          this.setStatus('paused', '连续无进展，请检查后继续。');
          throw new Error('Conversation progress limit reached');
        }
        let roundId: string;
        try { const budget = await this.budget.reserve(attempt, signal); this.requestCount = budget.totalUsed; roundId = budget.roundId; }
        catch (error) {
          if (error instanceof RequestBudgetError && error.code === 'budget-exhausted' && this.status === 'running')
            this.setStatus('paused', '本轮请求预算已用尽，请显式追加100次后继续。', 'budget-exhausted');
          throw error;
        }
        this.assertRemoteActive(); signal?.throwIfAborted();
        // Pi's session profile may still carry an older extra reviewer object.
        // Reviewer policy is worker-owned and updated independently of model selection.
        this.profile = { ...this.profile, ...profile, reviewer: this.profile.reviewer };
        this.requestStarted = Date.now();
        this.signals.event({ type: 'model-request', taskId: this.task.id,
          model: { provider: profile.provider, modelId: profile.modelId }, purpose, roundId, logicalRequestId: attempt.logicalRequestId, attempt: attempt.attempt, transport: attempt.transport, request: this.requestCount, createdAt: Date.now() });
        this.signals.event({ type: 'task-status', taskId: this.task.id, status: this.status, requestCount: this.requestCount });
      },
      event: taskSessionEvents(this.task.id, { event: (event) => this.signals.event(event), usageBudget: () => this.agent ? this.preparationSnapshot().budget : undefined,
        request: () => ({ count: this.requestCount, started: this.requestStarted }), activity: () => this.publishExecution(),
        compactionFailed: (error) => { if (this.status === 'running') this.setStatus('paused', error); },
        diagnostic: (event) => this.diagnostic(event), turnEnd: () => this.progress.endTurn() })
    });
  }

  /** In-memory session/frame only; no prompt, tools, ordinary budget or task status transition. */
  async previewContext() {
    await this.initializeSession();
    return this.preparationSnapshot();
  }
  async start(restored = false, thinkingLevel?: import('@cloudhelm/core').ThinkingLevel, document?: import('@cloudhelm/core').MessageDocument, initialMessage?: string, intent?: string): Promise<void> {
    const version = this.controlVersion;
    if (!restored) this.setStatus('running');
    await this.initializeSession(thinkingLevel);
    if (!this.agent) throw new Error('对话初始化未完成');
    const interrupted = version !== this.controlVersion;
    if (restored || interrupted) { this.needsRecovery = true; this.setStatus('paused', undefined, this.resumeReason); return; }
    this.setStatus('running');
    try {
      this.intent.begin(deriveInputIntent(initialMessage ?? this.task.goal, document, intent), document?.requestId);
      await this.agent.prompt(initialMessage ?? this.task.goal, document);
      if (this.status === 'running') this.finishRun();
    } catch (error) {
      if (this.status === 'running') this.setStatus('failed', error instanceof Error ? error.message : String(error), 'model');
    }
  }

  answerClarification(id: string, answers: unknown): void { this.clarification.answer(id, answers); }
  cancelClarification(id: string): void { this.clarification.cancel(id); }

  preparationSnapshot(scopes: LocalScope[] = [], pendingIntent?: import('@cloudhelm/contracts').TaskIntentState): PreparationSnapshot {
    return taskContextSnapshot({ agent: this.agent, task: this.task, hosts: this.hosts, scopes,
      operations: this.operationViews(), round: this.verificationOperations(), intent: this.intent.snapshot(), pendingIntent, privileged: this.privileged,
      hasReport: this.journal.hasReport(), needsRecovery: this.needsRecovery || ['paused', 'failed', 'recovering', 'human-control'].includes(this.status),
      interruption: this.pendingInterruption, modelIdle: !this.agent?.isStreaming && !this.isRunning() && !this.stopping,
      remoteIdle: !this.terminal.pendingOperations(this.task.id).length && !this.operationViews().some((op) =>
        ['proposed', 'approved', 'running', 'unknown'].includes(op.status) && !op.reconciledAt) });
  }
  preparationContext(requestId: string, profile: RuntimeProfile, signal: AbortSignal, scopes: LocalScope[] = []) {
    return taskPreparation({ agent: this.agent, expectedProfile: profile, signal, profile: () => this.profile,
      generation: () => this.requestGeneration(), snapshot: () => this.preparationSnapshot(scopes),
      reserve: (attempt, requestSignal) => this.budget.reserve(attempt, requestSignal, requestId), charged: (model, budget, attempt) => {
        this.requestCount = budget.totalUsed; this.requestStarted = Date.now();
        this.signals.event({ type: 'model-request', taskId: this.task.id, purpose: 'compaction', request: this.requestCount,
          model: { provider: model.provider, modelId: model.modelId }, roundId: budget.roundId, logicalRequestId: attempt.logicalRequestId, attempt: attempt.attempt, transport: attempt.transport, createdAt: this.requestStarted });
      } });
  }

  message(text: string, document?: import('@cloudhelm/core').MessageDocument, intent?: string, preparedRevision?: string): void {
    if (this.status === 'waiting-user') throw new Error('请先回答需求澄清，或停止本轮对话');
    if (!this.agent) throw new Error('Task has not started');
    if (this.agent.isStreaming && !['running', 'waiting-review'].includes(this.status)) throw new Error('AI 正在暂停，请稍后再发送消息。');
    // Only a closed, backend-recorded round can be replaced. Ordinary chat is never risk acceptance.
    const newRound = !this.remoteBlocked && !this.agent.isStreaming && this.verification.closed
      && this.resumeReason !== 'report' && !this.operationViews().some(operationNeedsVerification);
    const nextIntent = this.intent.previewInput(deriveInputIntent(text, document, intent), newRound, document?.requestId);
    const snapshot = this.preparationSnapshot([], preparedRevision ? undefined : nextIntent);
    assertPreparedInput(snapshot, preparedRevision ?? snapshot.revision, text);
    this.controlVersion++;
    if (newRound && this.journal.completionReport().reportStatus === 'verified') this.replayProtected.clear();
    if (['paused', 'failed', 'recovering', 'human-control'].includes(this.status)) this.needsRecovery = true;
    this.remoteBlocked = undefined;
    this.intent.input(deriveInputIntent(text, document, intent), newRound, document?.requestId);
    if (newRound) {
      this.journal.resetReport();
      this.signals.event({ type: 'verification-state', taskId: this.task.id });
    }
    if (this.agent.isStreaming) {
      void this.agent.steer(text, document).catch((error: unknown) => this.blockRemote(String(error)));
      return;
    }
    this.progress.reset();
    if (newRound) this.verification.begin(this.task.id);
    this.setStatus('running');
    void this.continueWithMessage(this.agent, text, document);
  }

  private async continueWithMessage(agent: ConversationSession, text: string, document?: import('@cloudhelm/core').MessageDocument): Promise<void> {
    try {
      await this.cleanupPromise;
      if (this.needsRecovery) {
        await agent.context(recoveryContextMessage(this.operationViews()));
        this.needsRecovery = false;
      }
      await this.appendInterruptionContext(agent);
      await agent.prompt(text, document);
      if (this.status === 'running') this.finishRun();
    } catch (error) {
      if (this.status === 'running') this.setStatus('failed', error instanceof Error ? error.message : String(error), 'model');
    }
  }

  pause(): void {
    this.controlVersion++;
    if (!['running', 'waiting-review', 'waiting-user', 'human-control'].includes(this.status)) { void this.agent?.abort(); return; }
    this.setStatus('paused', undefined, 'interrupted');
    this.clarification.cancel();
    this.agent?.abort();
  }

  resume(): Promise<void> {
    if (this.status === 'waiting-user') return Promise.reject(new Error('请先回答问题或停止本轮对话'));
    if (this.resuming?.version === this.controlVersion) return this.resuming.promise;
    if (!(['paused', 'failed', 'human-control', 'recovering'].includes(this.status)
      || (this.status === 'answered' && this.resumeReason === 'report')) || !this.resumeReason) {
      return Promise.reject(new Error('没有可自动继续的未完成步骤，请明确发送下一步指令。'));
    }
    const reason = this.resumeReason;
    const version = ++this.controlVersion;
    const promise = this.resumeOnce(version, reason).catch((error: unknown) => {
      if (version !== this.controlVersion) return;
      if (error instanceof RequestBudgetError) throw error;
      if (this.status === 'paused' || this.status === 'human-control') return;
      // User stop or a SafetyGate block already published the authoritative pause; ignore Pi's late abort error.
      if (this.status === 'running') this.setStatus('failed', error instanceof Error ? error.message : String(error), 'model');
      throw error;
    }).finally(() => {
      if (this.resuming?.version === version) this.resuming = undefined;
    });
    this.resuming = { version, promise };
    return promise;
  }

  private async resumeOnce(version: number, reason: ResumeReason): Promise<void> {
    if (!this.agent) return;
    await this.cleanupPromise;
    await this.agent.waitForIdle();
    if (version !== this.controlVersion) return;
    await this.budget.assertAvailable();
    if (version !== this.controlVersion) return;
    this.setStatus('running');
    for (const [hostId, previous] of this.terminalByHost) {
      if (this.terminal.isAgentOwner(previous)) continue;
      const opened = await this.openTerminal(hostId, this.task.id);
      if (version !== this.controlVersion) {
        // No command has been issued on this new session; discard a canceled hand-back.
        if (this.terminal.isAgentOwner(opened)) this.terminal.close(opened);
        return;
      }
      this.terminalByHost.set(hostId, opened);
      this.signals.event({ type: 'terminal-replaced', previousTerminalId: previous, terminalId: opened });
      if (!this.terminal.isAgentOwner(opened)) {
        this.blockRemote('终端状态已变化，请核验后继续。');
        return;
      }
    }
    this.progress.reset();
    this.remoteBlocked = undefined;
    this.setStatus('running');
    await this.appendInterruptionContext(this.agent);
    this.needsRecovery = false;
    const operations = this.operationViews();
    await this.agent.resumeWithContext(recoveryContextMessage(operations, reason));
    if (this.status === 'running') this.finishRun();
  }

  ownsTerminal(terminalId: string): boolean { return [...this.terminalByHost.values()].includes(terminalId) || !!this.privileged?.owns(terminalId); }

  /** Finished conversations may leave the worker; live ones must stay. */
  get canDelete(): boolean { return !isActiveTaskStatus(this.status) && !this.agent?.isStreaming && !this.terminal.pendingOperations(this.task.id).length; }

  async close(): Promise<void> {
    await this.agent?.abort();
    await this.agent?.waitForIdle();
    this.privileged?.close();
    await this.releaseRuntime();
    this.dispose();
  }

  /** Releases the task's terminals after the conversation has been deleted. */
  dispose(): void {
    this.agent?.dispose();
    this.signals.clearCredentials?.();
    this.privileged?.close();
    this.signals.abandonRuntime?.();
    this.terminal.closeTask(this.task.id);
    this.terminalByHost.clear();
  }

  addAuthorization(hosts: RuntimeHost[], scopes: LocalScope[], prepared?: import('@cloudhelm/contracts/runtime').PreparedContext & { text: string }): void {
    authorizeTaskInput(this.task, this.hosts, hosts, scopes, (next) => this.preparationSnapshot(next), (event) => this.signals.event(event), prepared);
  }

  private async ensureTerminal(hostId: string): Promise<string> {
    this.assertRemoteActive();
    const previous = this.terminalByHost.get(hostId);
    if (previous) {
      if (this.terminal.isAgentOwner(previous)) return previous;
      // A fresh session is opened only within an explicitly started conversation turn.
      // Unresolved outcomes remain guarded by the host executor and SafetyGate.
    }
    const opening = this.openingTerminals.get(hostId);
    if (opening) return opening;
    const pending = this.openTerminal(hostId, this.task.id).then((opened) => {
      this.terminalByHost.set(hostId, opened);
      if (previous) this.signals.event({ type: 'terminal-replaced', previousTerminalId: previous, terminalId: opened });
      if (this.remoteBlocked || !['running', 'waiting-review'].includes(this.status)) this.terminal.suspend(opened);
      this.assertRemoteActive();
      return opened;
    }).finally(() => this.openingTerminals.delete(hostId));
    this.openingTerminals.set(hostId, pending);
    return pending;
  }

  updateHostSafety(hostId: string, mode: ReviewMode, protectedReadPaths: string[], protectedWritePaths: string[], revision: number, sudoCachePolicy?: import('@cloudhelm/core').SudoCachePolicy): void {
    const host = this.hosts.find((candidate) => candidate.id === hostId);
    if (!host) return;
    this.signals.clearCredentials?.();
    host.defaultMode = mode;
    host.protectedReadPaths = [...protectedReadPaths];
    host.protectedWritePaths = [...protectedWritePaths];
    host.protectedPaths = [...new Set([...protectedReadPaths, ...protectedWritePaths])];
    host.policyRevision = revision;
    if (sudoCachePolicy) host.sudoCachePolicy = structuredClone(sudoCachePolicy);
  }

  updateConversationReviewMode(hostId: string, mode: ReviewMode, revision: number): void {
    if (!this.task.hostIds.includes(hostId)) throw new Error('Host is outside this conversation');
    this.task.reviewModesByHost = { ...this.task.reviewModesByHost, [hostId]: mode };
    this.task.reviewRevision = revision;
  }

  private scope(host: RuntimeHost, terminalId: string, cwd = this.terminal.workingDirectory(terminalId)): OperationScope {
    return taskOperationScope(this.task, host, terminalId, cwd, this.terminal, this.profile, this.intent, this.privileged);
  }

  private async performOperation(gate: SafetyGate, operation: ProposedOperation, signal: AbortSignal | undefined,
    hostLabel: string, manualReview = false) {
    this.assertRemoteActive();
    operation = await this.privileged?.prepare?.(operation) ?? operation;
    const analysis = operation.kind === 'command' ? await this.analyzer.analyze(operation.command).catch(() => undefined) : undefined;
    // Refuse sudo capability probes before review: they deserve no approval card and no pause.
    if (analysis && isSudoStatusProbe(analysis)) return blockedOperationFeedback(operation.id, 'unsupported-probe',
      'No command sent; effects: none. sudo 状态/权限探测（sudo -n true、sudo -l、sudo -v 等）不被支持，也不能证明下一条 sudo 命令可用。请直接提交实际的有界 sudo 命令，私有认证通道会在需要时提示输入。');
    // The authentication bridge cannot execute these forms. Refuse them before showing
    // an approval card; an approval cannot make an unsupported transport safe to run.
    if (analysis && operation.kind === 'command' && !operation.scope.sessionId && !inputPlan(analysis)
      && analysis.calls.some((call) => /(?:^|\/)(?:sudo|su)$/u.test(call.name))) return blockedOperationFeedback(operation.id, 'unsupported-authentication-form',
        'No command sent; effects: none. This sudo/su command form is unsupported by the private authentication channel (including sudo pipelines and redirections). Do not wrap or switch tools to bypass this limit. Submit the actual bounded sudo operation as one reviewed command, or explain that manual handling is required.');
    if (operation.kind === 'command' && analysis) {
      try { bindCommandExecutionPlan(operation, analysis); }
      catch { return blockedOperationFeedback(operation.id, 'unsupported-authentication-form', 'No command sent; the authentication form cannot be represented by a bounded reviewed execution plan.'); }
    }
    // Lookup and audit must use the same finalized identities, including compound sudo targets.
    if (!analysis || !isReadOnlyQuery(analysis)) {
      const key = operationIntentKey(operation);
      const denied = !manualReview && this.operationViews().find((item) =>
        item.intentKey === key && item.status === 'denied' && item.ruleId === 'ai-review-deny');
      if (denied) return blockedOperationFeedback(operation.id, 'prior-review-denied',
        `Not executed; effects: none. Independent AI review already denied the same operation (${denied.id}). Do not retry it under a new ID or wrapper. Propose a substantively safer action or let the user request exact manual review.`, denied.id);
      const previous = this.operationViews().find((item) => item.intentKey === key
        && (['running', 'proposed', 'approved', 'unknown'].includes(item.status) || (item.status === 'succeeded' && this.replayProtected.has(item.id))));
      if (previous) return blockedOperationFeedback(operation.id, 'replay-protected', `Not executed: operation ${previous.id} already records this action (${previous.status}). Read its log and inspect the actual result; do not replay it. A new operation ID does not make a retry safe.`, previous.id);
    }
    let preview: FileApprovalPreview | undefined;
    if (this.prepareRemote) {
      const prepared = await this.prepareRemote(operation, gate, signal);
      operation = prepared.operation; preview = prepared.preview;
      this.assertRemoteActive();
    }
    const outcome = await this.filePreviews.execute(gate, operation, signal, manualReview, preview);
    if (!outcome.result) return blockedOperationFeedback(operation.id, outcome.decision.ruleId,
      `Executed: false; effects: none. SafetyGate ${outcome.decision.verdict} (${outcome.decision.ruleId}): ${outcome.decision.reason}`, undefined, outcome.readOnly);
    const result = outcome.result;
    if (result.status !== 'succeeded') this.signals.clearCredentials?.();
    if (result.requiresUserAction) {
      this.blockRemote(result.privilege ? privilegeGuidance(result.privilege) : '认证未通过或当前认证形式需要人工接管，已暂停。请处理后手动继续，AI 不会自动改换方式重试。', false, 'interrupted');
    } else if (result.status === 'handed-over') {
      this.blockRemote('终端已转为人工输入；请核验结果后发送消息继续。');
    } else if (result.status === 'unknown') {
      this.blockRemote('远端操作结果未知，已暂停。请先核验，避免重复执行。', false, 'verify');
    } else if (!this.terminal.isAgentOwner(operation.scope.terminalId)) {
      this.blockRemote('远端终端已暂停或被接管，请核验后手动继续。');
    } else if (result.status === 'failed' && result.effects === 'possible' && outcome.readOnly !== true) {
      this.blockRemote('操作失败且可能已产生部分变更。已暂停，请先核验原结果，再决定后续操作。', false, 'verify');
    } else if (result.status === 'failed') {
      const key = `${operation.scope.hostId}:${operationPreview(operation)}:${result.exitCode ?? 'unknown'}`;
      this.sameFailureCount = key === this.lastFailureKey ? this.sameFailureCount + 1 : 1;
      this.lastFailureKey = key;
      if (this.sameFailureCount >= 3) {
        this.setStatus('paused', 'The same operation failed three consecutive times');
        this.agent?.abort();
      }
    } else if (result.status === 'succeeded') {
      this.progress.observe('operation', JSON.stringify([operationIntentKey(operation), result.stdoutTail, result.exitCode, result.effects]));
      this.sameFailureCount = 0;
      this.lastFailureKey = '';
    }
    return operationToolResult(result, hostLabel, outcome.readOnly);
  }

  private diagnostic(event: DiagnosticEvent): void {
    this.signals.diagnostic?.(safeDiagnostic({ ...event, taskId: this.task.id }));
  }

  private assertRemoteActive(): void {
    if (this.remoteBlocked || !['running', 'waiting-review'].includes(this.status)) {
      throw new Error(this.remoteBlocked ?? 'Task is paused; wait for an explicit user continuation.');
    }
  }

  private blockRemote(reason: string, human = false, resumeReason?: ResumeReason): void {
    if (this.remoteBlocked) return;
    this.remoteBlocked = reason;
    this.setStatus(human || this.status === 'human-control' ? 'human-control' : 'paused', reason, resumeReason);
    this.agent?.abort();
  }

  private createGate(maintenance = false): SafetyGate {
    const audit: OperationAudit = {
      proposed: async (operation) => {
        this.diagnostic({ event: 'operation.proposed', hostId: operation.scope.hostId, operationId: operation.id,
          runAs: operation.scope.runAs, loginAs: operation.scope.loginAs, sessionId: operation.scope.sessionId, cwd: operation.scope.cwd, policyRevision: operation.scope.policyRevision });
        this.proposedOperations.set(operation.id, operation);
        this.updateOperation(operation, 'proposed', await verificationSource(operation, this.analyzer));
        this.filePreviews.proposed(operation);
      },
      classified: async (id, readOnly) => {
        const view = this.operations.get(id);
        if (!view) return;
        view.readOnly = readOnly;
        this.signals.event({ type: 'operation', value: view });
      },
      decided: async (id, decision) => {
        this.diagnostic({ event: 'review.result', operationId: id, status: decision.verdict, ruleId: decision.ruleId });
        this.updateDecision(id, decision);
        if (decision.ruleId === 'ai-review-deny') {
          const proposed = this.proposedOperations.get(id);
          if (proposed) this.aiDeniedOperations.set(id, proposed);
          this.consecutiveAiDenials++;
          if (this.consecutiveAiDenials >= 3) this.blockRemote('独立审核连续拒绝三次，已暂停以避免反复试探。请检查目标或人工处理。');
        } else if (decision.verdict === 'allow') {
          this.consecutiveAiDenials = 0;
          this.aiDeniedOperations.delete(id);
        } else if (decision.verdict !== 'ask' && decision.verdict !== 'evaluate') {
          this.blockRemote(`操作未执行，审核未放行（${decision.ruleId}）：${decision.reason}。已暂停，请处理后手动继续。`);
        }
      },
      completed: async (result) => {
        this.proposedOperations.delete(result.operationId);
        const operation = this.operations.get(result.operationId);
        if (!operation) return;
        applyOperationCompletion(operation, result);
        this.signals.event({ type: 'operation', value: operation });
        this.verification.pending(this.task.id, operation, this.operationViews());
        if (!this.isRunning()) this.journal.finalize(this.verification.id);
        this.publishExecution();
      }
    };
    return new SafetyGate({
      analyzer: this.analyzer,
      scripts: this.scripts,
      evaluator: new AiRiskEvaluator(() => this.profile.reviewer ? {
        provider: this.profile.reviewer.provider, modelId: this.profile.reviewer.modelId,
        apiKey: this.profile.reviewer.apiKey, baseUrl: this.profile.reviewer.baseUrl,
        kind: this.profile.reviewer.selection.kind
      } : { provider: this.profile.provider, modelId: this.profile.modelId, apiKey: this.profile.apiKey,
        baseUrl: this.profile.baseUrl, kind: 'current' }, createTaskReviewer(this.task.id, this.signals.budget, () => this.assertRemoteActive(), () => this.requestGeneration()),
      () => this.operationViews().slice(-5).map((item) => `${item.kind} ${item.status}: ${item.kind === 'command' ? redactOutput(item.preview).slice(0, 400) : item.preview.split('\n')[0]}`)),
      approvals: { requestApproval: async (request) => {
        if (!maintenance) this.setStatus('waiting-review');
        const view = approvalView(request);
        const allowed = await this.signals.requestApproval(view);
        if (!maintenance && this.status === 'waiting-review') this.setStatus('running');
        return allowed;
      }, cancelApproval: (id) => this.signals.cancelApproval(id) },
      executor: maintenance ? { execute: (operation, fingerprint, signal, options) => {
        if (operation.kind !== 'runtime' || operation.runtime.action !== 'cleanup') throw new Error('Maintenance gate only authorizes fixed runtime cleanup');
        return this.executor.execute(operation, fingerprint, signal, options);
      } } : this.executor, audit, lease: {
        currentGeneration: (id) => this.terminal.currentGeneration(id),
        isAgentOwner: (id) => (maintenance || !this.remoteBlocked && ['running', 'waiting-review'].includes(this.status))
          && this.terminal.isAgentOwner(id)
      },
      settings: (hostId) => ({ mode: this.task.reviewModesByHost?.[hostId]
        ?? this.hosts.find((host) => host.id === hostId)?.defaultMode ?? 'ask',
        revision: this.hosts.find((host) => host.id === hostId)?.policyRevision ?? -1,
        conversationRevision: this.task.reviewRevision ?? 1,
        reviewerRevision: this.profile.reviewer?.revision ?? 1 })
    });
  }

  private updateOperation(operation: ProposedOperation, status: OperationView['status'], source?: OperationView['verificationSource']): void {
    if (operation.kind !== 'runtime') this.verification.record(this.task.id, operation.id);
    const view: OperationView = {
      verificationSource: source, fileTransactionId: 'filePlan' in operation ? operation.filePlan?.transactionId : undefined,
      outputExpectation: operation.kind === 'command' ? operation.outputExpectation : undefined,
      serviceUnit: operation.kind === 'command' ? operation.serviceUnit : undefined,
      commandSource: operation.kind === 'command' && redactOutput(operation.scope.cwd) === operation.scope.cwd
        ? { version: 1, cwd: operation.scope.cwd } : undefined,
      intentKey: operationIntentKey(operation), id: operation.id, taskId: this.task.id, hostId: operation.scope.hostId, kind: operation.kind,
      preview: operationPreview(operation), status, runAs: operation.scope.runAs, loginAs: operation.scope.loginAs, logRef: operation.scope.terminalId,
      model: { provider: this.profile.provider, modelId: this.profile.modelId }, createdAt: Date.now()
    };
    this.replayProtected.add(operation.id);
    this.operations.set(operation.id, view);
    this.signals.event({ type: 'operation', value: view });
  }

  private updateDecision(id: string, decision: SafetyDecision): void {
    const view = this.operations.get(id);
    if (!view) return;
    applyOperationDecision(view, decision, this.consecutiveAiDenials);
    this.signals.event({ type: 'operation', value: view });
  }

  recordFileRecovery(operation: OperationView): void {
    if (operation.taskId !== this.task.id || operation.fileRecovery?.evidence !== 'receipt-confirmed') return;
    this.operations.set(operation.id, structuredClone(operation)); this.publishExecution();
  }

  recordRemoteResult(result: OperationResult): void {
    const operation = this.operations.get(result.operationId);
    if (!operation) return;
    applyOperationCompletion(operation, result);
    this.signals.event({ type: 'operation', value: operation });
    this.verification.pending(this.task.id, operation, this.operationViews());
    this.publishExecution();
    if (this.status === 'answered') this.finishRun();
    else if (!this.isRunning()) this.journal.finalize(this.verification.id);
    if (!this.isRunning() && operation.logRef) this.terminal.releaseIdle(operation.logRef);
  }

  /** Cross-conversation recovery resolves outcomes this task may have created earlier. */
  assertResolvableOutcome(operationId: string): void {
    const operation = this.operationViews().find((item) => item.id === operationId);
    if (operation && !operationOutcomeResolvable(operation)) throw new Error('该操作仍在执行或已核验，不能重复确认风险');
  }

  /** Applies a user risk acceptance without ever claiming an observed outcome. */
  recordRiskAcceptance(accepted: OperationView): void {
    if (accepted.taskId !== this.task.id) return;
    const operation = this.operationViews().find((item) => item.id === accepted.id);
    if (!operation) return;
    this.operations.set(operation.id, applyCommittedRiskAcceptance(operation, accepted));
    this.progress.observe('resolution', JSON.stringify([operation.id, accepted.reconciliation?.kind]));
    if (this.status === 'answered') this.finishRun();
    else this.journal.finalize(this.verification.id);
    this.publishExecution();
  }

  setReviewKey(jevKey?: string): void { this.profile = { ...this.profile, jevKey }; this.agent?.setReviewKey(jevKey); }

  needsReviewProfile(reviewer: NonNullable<RuntimeProfile['reviewer']>): boolean {
    reviewer = resolveTaskReviewer(this.profile, reviewer);
    const current = this.profile.reviewer;
    return !current || reviewer.revision > current.revision
      || current.provider !== reviewer.provider || current.modelId !== reviewer.modelId
      || current.apiKey !== reviewer.apiKey || current.baseUrl !== reviewer.baseUrl
      || JSON.stringify(current.selection) !== JSON.stringify(reviewer.selection);
  }

  setReviewProfile(reviewer: NonNullable<RuntimeProfile['reviewer']>): void {
    reviewer = resolveTaskReviewer(this.profile, reviewer);
    if (!this.needsReviewProfile(reviewer)) return;
    this.profile = { ...this.profile, reviewer: { ...reviewer,
      revision: Math.max(reviewer.revision, (this.profile.reviewer?.revision ?? 0) + 1) } };
  }

  async requestAiDenialReview(operationId: string): Promise<void> {
    const operation = this.aiDeniedOperations.get(operationId);
    if (!operation || !this.operations.get(operationId)?.manualReviewAvailable) throw new Error('该操作已过期或不可复核');
    if (this.manualReviewsInFlight.has(operationId)) throw new Error('该操作正在人工复核');
    this.manualReviewsInFlight.add(operationId);
    const controlVersion = this.controlVersion;
    try {
      await this.agent?.waitForIdle();
      if (controlVersion !== this.controlVersion) throw new Error('对话控制状态已变化，请重新提出操作');
      if (this.remoteBlocked || this.terminal.pendingOperations(this.task.id).length) throw new Error('远端状态未确定，请先核验后继续');
      if (!this.operations.get(operationId)?.manualReviewAvailable) throw new Error('该操作已过期或不可复核');
      const host = this.hosts.find((candidate) => candidate.id === operation.scope.hostId);
      if (!host || host.username !== (operation.scope.loginAs ?? operation.scope.runAs)
        || host.policyRevision !== operation.scope.policyRevision
        || (this.task.reviewRevision ?? 1) !== (operation.scope.conversationRevision ?? 1)
        || (this.profile.reviewer?.revision ?? 1) !== (operation.scope.reviewerRevision ?? 1)) {
        throw new Error('主机身份或审核策略已变化，请重新提出操作');
      }
      let terminalId = operation.scope.terminalId;
      if (!this.terminal.isAgentOwner(terminalId)) {
        if (operation.scope.sessionId) throw new Error('特权会话已失效，请重新建立后提出操作');
        terminalId = await this.openTerminal(host.id, this.task.id);
        if (controlVersion !== this.controlVersion) {
          if (this.terminal.isAgentOwner(terminalId)) this.terminal.close(terminalId);
          throw new Error('对话控制状态已变化，复核未开始');
        }
        if (!this.terminal.isAgentOwner(terminalId)) throw new Error('新终端未交给 AI，复核未开始');
        this.terminalByHost.set(host.id, terminalId);
        this.signals.event({ type: 'terminal-replaced', previousTerminalId: operation.scope.terminalId, terminalId });
      }
      const reviewed: ProposedOperation = { ...operation, id: randomUUID(), scope: {
        ...this.scope(host, terminalId, operation.scope.cwd),
        runAs: operation.scope.runAs,
        goal: operation.scope.goal, intent: operation.scope.intent
      } };
      const view = this.operations.get(operationId)!;
      view.manualReviewAvailable = false;
      this.aiDeniedOperations.delete(operationId);
      this.signals.event({ type: 'operation', value: view });
      this.setStatus('running');
      try {
        await this.runOperation(this.createGate(), reviewed, undefined, host.label, true);
      } finally {
        if (this.status === 'running') this.setStatus('paused', '人工复核已结束，请核验这次操作的实际结果');
      }
    } finally {
      this.manualReviewsInFlight.delete(operationId);
    }
  }

  setThinking(level: import('@cloudhelm/core').ThinkingLevel): void {
    if (!this.agent) throw new Error('会话尚未就绪');
    this.agent.setThinking(level);
  }

  setModel(profile: RuntimeProfile): void {
    if (!this.agent) throw new Error('会话尚未就绪');
    this.agent.select(profile);
    this.profile = { ...profile, reviewer: profile.reviewer ? {
      ...profile.reviewer, revision: Math.max(profile.reviewer.revision, (this.profile.reviewer?.revision ?? 0) + 1)
    } : undefined };
  }

  isRunning(): boolean { return ['running', 'waiting-review', 'waiting-user', 'recovering'].includes(this.status); }

  terminalInput(terminalId: string, data: string): void {
    if (data === '\u0003' && (this.isRunning() || this.terminal.hasPending(terminalId))) {
      this.stopOperation('ctrl-c'); return;
    }
    if (this.isRunning()) throw new Error('AI 正在运行，请先停止再输入');
    if (this.terminal.hasPending(terminalId)) throw new Error('终端暂不可输入，请先停止 AI 并等待命令退出');
    this.terminal.releaseIdle(terminalId);
    this.terminal.input(terminalId, data, true);
  }

  stopOperation(source: InterruptionSource = 'stop-button'): void {
    if (this.stopping) return;
    const pending = this.terminal.pendingOperations(this.task.id);
    const operationIds = [...new Set([...pending, ...[...this.operations.values()].filter((op) => ['running', 'proposed', 'approved'].includes(op.status)).map((op) => op.id)])];
    if (!this.isRunning() && !pending.length && !operationIds.some((id) => !this.operations.get(id)?.interruption)) return;
    this.stopping = true;
    this.publishExecution();
    const interruption: UserInterruption = { source, requestedAt: Date.now(), operationIds };
    this.pendingInterruption = interruption;
    const text = source === 'terminal-close'
      ? '用户主动关闭终端，已停止本轮 AI。远端命令是否退出仍需核验；不得把这次中断当作程序自行失败或自动重试。'
      : `用户通过${source === 'ctrl-c' ? ' Ctrl+C ' : '停止按钮'}主动终止本轮执行。已请求停止远端命令，但不代表进程已退出；下一轮先核验结果，不自动重试被用户终止的操作。`;
    this.signals.event({ type: 'task-message', taskId: this.task.id, role: 'system', text, interruption, createdAt: interruption.requestedAt });
    for (const id of operationIds) {
      const op = this.operations.get(id);
      if (op) { op.interruption = interruption; this.signals.event({ type: 'operation', value: op }); }
    }
    this.remoteBlocked = text;
    this.agent?.clearQueue();
    // Pausing the model invalidates queued writes; it does not prove remote termination.
    this.agent?.abort();
    try { if (source !== 'terminal-close') this.terminal.stopTaskCommands(this.task.id); }
    catch (error) { this.stopping = false; throw error; }
    finally { this.pause(); this.setStatus('paused', text, 'interrupted'); }
  }

  private async appendInterruptionContext(agent: ConversationSession): Promise<void> {
    if (!this.pendingInterruption) return;
    const interruption = this.pendingInterruption;
    this.pendingInterruption = undefined;
    await agent.context(interruptionContext(interruption, this.operationViews()));
  }

  private operationViews(): OperationView[] {
    return mergeOperationViews([...this.priorOperations, ...this.operations.values()]);
  }

  private verificationOperations(): OperationView[] {
    return this.verification.operations(this.operationViews());
  }

  private finishRun(): void {
    this.journal.finalize(this.verification.id);
    const completion = decideTaskCompletion({ operations: this.operationViews(),
      roundOperations: this.verificationOperations(), answered: this.agent?.lastTurnAnswered ?? false,
      hasReport: this.journal.hasReport(), reportIssue: this.journal.lastReportIssue(), ...this.journal.completionReport() });
    if (completion.verificationState !== undefined) this.signals.event({ type: 'verification-state',
      taskId: this.task.id, value: completion.verificationState ?? undefined });
    if (completion.status === 'answered') this.verification.close(this.task.id);
    this.setStatus(completion.status, completion.summary, completion.resumeReason);
  }

  private requestGeneration(): string { return JSON.stringify([this.controlVersion, this.task.reviewRevision, this.profile.reviewer?.revision, this.hosts.map((host) => [host.id, host.policyRevision])]); }
  private publishExecution(): void {
    const model = this.agent?.isStreaming || this.isRunning() ? 'running' : 'idle';
    const pending = this.terminal.pendingOperations(this.task.id).length > 0;
    const remote = pending ? 'running' : this.operationViews().some((op) => op.status === 'unknown' && !op.reconciledAt) ? 'unknown' : 'idle';
    if (model === 'idle' && !pending) this.stopping = false;
    this.signals.event({ type: 'execution', taskId: this.task.id, value: {
      model, remote, stopping: this.stopping, canStop: model === 'running' || pending
    } });
  }

  private setStatus(status: TaskStatus, summary?: string, resumeReason?: ResumeReason): void {
    this.status = status;
    this.resumeReason = resumeReason;
    if (status === 'paused' || status === 'failed') this.journal.finalize(this.verification.id);
    this.publishExecution();
    if (!this.isRunning()) {
      this.signals.clearCredentials?.(); this.privileged?.close();
      void this.releaseRuntime();
    }
    if (!this.isRunning()) for (const id of this.terminalByHost.values()) this.terminal.releaseIdle(id);
    this.signals.event({ type: 'task-status', taskId: this.task.id, status, summary, resumeReason, requestCount: this.requestCount });
  }

  private releaseRuntime(): Promise<void> {
    if (!this.signals.cleanupRuntime) return Promise.resolve();
    if (this.cleanupPromise) return this.cleanupPromise;
    const knownIdle = !this.terminal.pendingOperations(this.task.id).length && !this.operationViews().some((operation) =>
      ['proposed', 'approved', 'running', 'unknown'].includes(operation.status) && !operation.reconciledAt);
    const work = this.signals.cleanupRuntime(this.createGate(true), knownIdle, (scope) => {
      const host = this.hosts.find((item) => item.id === scope.hostId);
      if (!host) throw new Error('Runtime cleanup host no longer authorized');
      return { ...scope, policyRevision: host.policyRevision, conversationRevision: this.task.reviewRevision ?? 1,
        reviewerRevision: this.profile.reviewer?.revision ?? 1, protectedPaths: [...host.protectedPaths],
        protectedReadPaths: [...(host.protectedReadPaths ?? host.protectedPaths)], protectedWritePaths: [...(host.protectedWritePaths ?? host.protectedPaths)] };
    }).catch(() => { this.signals.abandonRuntime?.(); }).finally(() => { if (this.cleanupPromise === work) this.cleanupPromise = undefined; });
    this.cleanupPromise = work; return work;
  }
}
