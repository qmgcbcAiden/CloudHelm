import { fileReadProtectionReason } from '@cloudhelm/core';
import { recoverManagedFile } from './file-recovery-runtime.js';
import { FileTransactionClient } from './file-transaction-client.js';
import { RuntimeResourceClient } from './runtime-resource-client.js';
import { NativeRuntimePreparation } from './native-runtime-preparation.js';
import { NativeFileClient, quoteRemote } from '@cloudhelm/adapters';
import { prepareFileOperation, type ManagedFileOperation } from '@cloudhelm/application';
import { LocalFileAccess } from './local-file-access.js';
import { MessagePreparations } from './message-preparations.js';
import { ShellMarkerParser } from '@cloudhelm/adapters';
import { StringDecoder } from 'node:string_decoder';
import { PrivilegedRuntime } from './privileged-runtime.js';
import { isPrivateInputAnswer, privateAnswerValue, safeDiagnostic, type PrivateInputAnswer } from '@cloudhelm/core';
import { eventDiagnostic, reservationDiagnostic } from './diagnostic-events.js';
import { HostSerialExecutor, PermissionAwareExecutor, InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, HostKeyError, SshCommandTerminal, SshTransport, type SshHost, type SshLoginPrompt } from '@cloudhelm/adapters';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RawTerminal } from '@cloudhelm/core';
import type { ApprovalView, InputRequestView } from '@cloudhelm/contracts';
import type { LogPage, RuntimeCall, RuntimeHost, RuntimeMessage } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner.js';
import { assertCommittedRiskAcceptance } from './risk-acceptance.js';
import { OperationInputBridge } from './operation-input-bridge.js';
import { testModelConnection } from '@cloudhelm/adapters';
import { FileOperationExecutor } from './file-operation-executor.js';
import { testHostConnection } from './host-connection-test.js';
import { RequestBudgetClient } from './request-budget-client.js';

export class WorkerServer {
  private readonly budget: RequestBudgetClient;
  private readonly fileJournal: FileTransactionClient;
  private readonly resourceJournal: RuntimeResourceClient;
  private readonly native: NativeRuntimePreparation;
  private readonly deliveredMessages = new Set<string>();
  private readonly preparations: MessagePreparations;
  private readonly logRequests = new Map<string, { resolve(value: LogPage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly ssh = new SshTransport((hostId) => {
    for (const runner of this.tasks.values()) if (runner.task.hostIds.includes(hostId)) {
      this.preparations.cancelTask(runner.task.id); runner.pause();
    }
    try { this.terminal.closeHost(hostId); }
    finally { this.post({ event: { type: 'host-status', hostId, status: 'disconnected' } }); }
  });
  private readonly terminal: TerminalManager;
  private readonly executor: HostSerialExecutor;
  private readonly privileged: PrivilegedRuntime;
  private readonly commands: OperationInputBridge;
  private readonly hosts = new Map<string, RuntimeHost>();
  private readonly interactions: InteractionCoordinator;
  private readonly tasks = new Map<string, TaskRunner>();
  private readonly pendingApprovals = new Map<string, { taskId: string; hostId: string; resolve(allowed: boolean): void }>();
  private readonly pendingInputs = new Map<string, { connectionId: string; expiresAt: number; resolve(answer: string | null): void; timeout: ReturnType<typeof setTimeout> }>();

  constructor(private readonly send: (message: RuntimeMessage) => void) {
    this.fileJournal = new FileTransactionClient((message) => this.post(message));
    this.resourceJournal = new RuntimeResourceClient((message) => this.post(message));
    this.budget = new RequestBudgetClient((message) => this.post(message), 30_000, (command, value) => {
      const diagnostic = reservationDiagnostic(command, value); if (diagnostic) this.send({ diagnostic });
    });
    this.preparations = new MessagePreparations(this.budget, (event) => this.post({ event }));
    this.terminal = new TerminalManager({
      command: (terminalId, generation, event) => this.post({ event: { type: 'terminal-command', terminalId, generation, ...event } }),
      data: (terminalId, data, operationId) => this.post({ event: { type: 'terminal-data', terminalId, data, operationId } }),
      completed: (result) => {
        const hostId = result.logRef ? this.terminal.hostOf(result.logRef) : undefined;
        if (hostId) this.executor?.observe(hostId, result);
        for (const runner of this.tasks.values()) runner.recordRemoteResult(result);
      },
      state: (terminalId, state) => {
        if (state !== 'agent') { this.interactions?.cancelForTerminal(terminalId); this.commands?.clearTerminal(terminalId); }
        this.post({ event: { type: 'terminal-state', terminalId,
          hostId: this.terminal.hostOf(terminalId) ?? '', taskId: this.terminal.taskOf(terminalId), state } });
      }
    });
    this.interactions = new InteractionCoordinator(this.terminal, {
      opened: (request) => this.post({ event: { type: 'input-open', value: {
        id: request.id, taskId: request.taskId, operationId: request.operationId, hostId: request.hostId,
        title: request.prompt, explanation: `${request.reason} 接收方：${request.recipient}`, kind: request.kind,
        choices: request.choices, expiresAt: request.expiresAt, allowPasswordCache: request.allowPasswordCache
      } } }),
      closed: (id) => this.post({ event: { type: 'input-close', id } })
    });
    this.commands = new OperationInputBridge(this.terminal, this.ssh, this.interactions,
      (taskId, hostId) => this.post({ event: { type: 'task-message', taskId, role: 'system',
        text: `已审核的安装操作在主机 ${hostId} 上需要普通继续确认，APT 报告 0 项删除，已自动回答 y。`, createdAt: Date.now() } }),
      (taskId, hostId, operationId) => this.post({ diagnostic: { event: 'authentication.reused', taskId, hostId, operationId } }));
    this.native = new NativeRuntimePreparation(this.terminal, (record) => this.resourceJournal.commit(record));
    this.privileged = new PrivilegedRuntime({ runtime: this.native, commands: this.commands, files: (op) => this.files(op), terminal: this.terminal, ssh: this.ssh,
      ordinary: new FileOperationExecutor(this.terminal, this.ssh, this.commands, (op) => this.files(op)),
      jump: (host) => host.jumpHostId ? this.hosts.get(host.jumpHostId) : undefined,
      input: (request, signal) => this.requestPrivateInput(request, signal) });
    this.executor = new HostSerialExecutor(new PermissionAwareExecutor({ execute: (operation, fingerprint, signal, options) =>
      (operation.kind === 'runtime' ? this.native : this.privileged).execute(operation, fingerprint, signal, options) }, new BashAnalyzer()));
  }

  resolveFileJournal(value: unknown): void { this.fileJournal.resolve(value); }
  resolveRuntimeResource(value: import('@cloudhelm/contracts').RuntimeResourceResult['runtimeResourceResult']): void { this.resourceJournal.receive(value); }

  private async inspectScript(operation: import('@cloudhelm/core').ProposedOperation, scriptPath: string) {
    const target = path.posix.resolve(operation.scope.cwd, scriptPath);
    const read: ManagedFileOperation = { id: operation.id, kind: 'write-file', path: target, content: '', scope: operation.scope };
    const result = await this.files(read).remote.inspect(read, target);
    if (!result.snapshot.exists || !result.snapshot.sha256) throw new Error('Script snapshot unavailable');
    return { source: Buffer.from(result.content).toString('utf8'), sha256: result.snapshot.sha256 };
  }

  private files(operation: ManagedFileOperation) {
    const ssh = this.privileged.fileTransport(operation);
    const info = ssh.nativeInfo(operation.scope.hostId, operation.scope.sessionId ?? operation.scope.terminalId, operation.scope.terminalGeneration);
    if (!info) throw new Error('Native file runtime unavailable');
    const generation = ssh.connectionGeneration(operation.scope.hostId);
    const current = () => {
      const host = this.hosts.get(operation.scope.hostId);
      if (!host || host.policyRevision !== operation.scope.policyRevision) throw new Error('File policy changed');
      const target = operation.kind === 'upload' ? operation.remotePath : operation.path;
      const reason = fileReadProtectionReason(target, { ...operation.scope, protectedReadPaths: host.protectedReadPaths ?? host.protectedPaths }, operation.filePlan?.transactionId);
      if (reason) throw new Error(reason);
      if (generation !== ssh.connectionGeneration(operation.scope.hostId) || !this.terminal.isAgentOwner(operation.scope.terminalId)
        || this.terminal.currentGeneration(operation.scope.terminalId) !== operation.scope.terminalGeneration) throw new Error('File session expired');
    };
    const remote = new NativeFileClient(info.artifact, async (op, signal, assertAuthorized) => {
      current(); signal?.throwIfAborted(); assertAuthorized?.();
      const channel = await ssh.openPipe(op.scope.hostId, `${quoteRemote(info.executable)} --files`);
      try { current(); signal?.throwIfAborted(); assertAuthorized?.(); }
      catch (error) { channel.destroy(); throw error; }
      return { channel, assertCurrent: current, binding: { version: 1 as const, sessionId: op.scope.sessionId ?? op.scope.terminalId,
        operationId: op.id, generation: op.scope.terminalGeneration } };
    });
    return { remote, journal: this.fileJournal };
  }

  private post(message: RuntimeMessage): void {
    const diagnostic = eventDiagnostic(message);
    if (diagnostic) this.send({ diagnostic });
    this.send(message);
  }

  private invalidatePreparation(call: RuntimeCall): void {
    if ('taskId' in call && call.taskId && ['set-conversation-thinking', 'set-conversation-model', 'stop-operation',
      'update-conversation-review-mode', 'request-ai-denial-review', 'authorize-task', 'task-message', 'answer-clarification',
      'cancel-clarification', 'pause-task', 'resume-task', 'delete-task'].includes(call.method)) this.preparations.cancelTask(call.taskId);
    if (call.method === 'set-review-key') this.preparations.cancelAll();
    if (call.method === 'commit-operation-risk') this.preparations.cancelTask(call.operation.taskId);
    if (call.method === 'disconnect' || call.method === 'update-host-safety') {
      for (const runner of this.tasks.values()) if (runner.task.hostIds.includes(call.hostId)) this.preparations.cancelTask(runner.task.id);
    }
    if ('terminalId' in call && ['close-terminal', 'stop-terminal', 'terminal-input'].includes(call.method)) {
      const taskId = this.terminal.taskOf(call.terminalId); if (taskId) this.preparations.cancelTask(taskId);
    }
  }

  async dispatch(call: RuntimeCall): Promise<unknown> {
    this.invalidatePreparation(call);
    switch (call.method) {
      case 'cancel-message': this.preparations.cancel(call.requestId); return;
      case 'prepare-message': return this.preparations.prepare(call, call.taskId ? this.tasks.get(call.taskId) : undefined);
      case 'restore-operations': return this.executor.restore(call.operations);
      case 'prepare-operation-risk':
        for (const runner of this.tasks.values()) runner.assertResolvableOutcome(call.operationId);
        if (!this.executor.canReconcile(call.hostId, call.operationId)) {
          throw new Error('原远端操作仍在运行，请等待其退出或停止后重试');
        }
        return;
      case 'commit-operation-risk': {
        assertCommittedRiskAcceptance(call.operation);
        if (!this.executor.reconcile(call.operation.hostId, call.operation.id)) throw new Error('远端进程尚未退出，无法解除写锁');
        // The durable acceptance already exists. A failed execution-status
        // notification must not turn this successful release into a rollback
        // of the authoritative record while the executor remains unlocked.
        for (const runner of this.tasks.values()) {
          try { runner.recordRiskAcceptance(call.operation); }
          catch { console.warn('Could not publish risk acceptance execution status'); }
        }
        return;
      }
      case 'recover-file-transaction': return recoverManagedFile(call.record, {
        terminal: this.terminal, ssh: this.ssh, native: this.native, privileged: this.privileged,
        executor: this.executor, journal: this.fileJournal, files: (op) => this.files(op), host: (id) => this.hosts.get(id),
        approval: (view) => this.requestApproval(view), cancelApproval: (id) => this.cancelApproval(id),
        operation: (value) => this.post({ event: { type: 'operation', value } })
      });
      case 'commit-file-recovery': {
        const op = call.operation;
        const record = op.fileTransactionId ? await this.fileJournal.get(op.fileTransactionId) : undefined;
        if (!record || record.stage !== 'confirmed' || !record.receipt || record.operationId !== op.id
          || record.taskId !== op.taskId || record.hostId !== op.hostId || op.fileRecovery?.evidence !== 'receipt-confirmed'
          || !op.reconciledAt || op.fileRecovery.transactionId !== record.id) throw new Error('文件核验凭据未持久化');
        if (!this.executor.reconcile(op.hostId, op.id)) throw new Error('原操作仍在运行，未解除写锁');
        for (const runner of this.tasks.values()) runner.recordFileRecovery(op);
        return;
      }
      case 'has-task': return this.tasks.has(call.taskId);
      case 'set-review-key':
        for (const runner of this.tasks.values()) runner.setReviewKey(call.jevKey);
        return;
      case 'set-review-profile': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话运行已失效');
        if (runner.needsReviewProfile(call.reviewer)) {
          this.preparations.cancelTask(call.taskId);
          for (const [id, pending] of this.pendingApprovals) if (pending.taskId === call.taskId) this.cancelApproval(id);
          runner.setReviewProfile(call.reviewer);
        }
        return;
      }
      case 'test-model': return testModelConnection(call.profile);
      case 'set-conversation-thinking': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话尚未恢复');
        runner.setThinking(call.level); return;
      }
      case 'set-conversation-model': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话尚未恢复');
        runner.setModel(call.profile); return;
      }
      case 'stop-operation': return this.tasks.get(call.taskId)?.stopOperation();
      case 'disconnect':
        for (const runner of this.tasks.values()) if (runner.task.hostIds.includes(call.hostId)) runner.pause();
        try { this.terminal.closeHost(call.hostId); }
        finally { this.ssh.disconnect(call.hostId); }
        return;
      case 'connect': return this.connect(call.host, call.jump);
      case 'test-host': return testHostConnection(call.host, call.jump);
      case 'update-host-safety':
        for (const [id, pending] of this.pendingApprovals) {
          if (pending.hostId === call.hostId) this.cancelApproval(id);
        }
        this.commands.clearHost(call.hostId);
        for (const runner of this.tasks.values()) runner.updateHostSafety(call.hostId, call.mode,
          call.protectedReadPaths, call.protectedWritePaths, call.revision, call.sudoCachePolicy);
        if (this.hosts.has(call.hostId)) Object.assign(this.hosts.get(call.hostId)!, {
          defaultMode: call.mode, policyRevision: call.revision, protectedReadPaths: call.protectedReadPaths,
          protectedWritePaths: call.protectedWritePaths, ...(call.sudoCachePolicy ? { sudoCachePolicy: call.sudoCachePolicy } : {})
        });
        return;
      case 'update-conversation-review-mode': {
        for (const [id, pending] of this.pendingApprovals) {
          if (pending.taskId === call.taskId && pending.hostId === call.hostId) this.cancelApproval(id);
        }
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话运行已失效');
        runner.updateConversationReviewMode(call.hostId, call.mode, call.revision);
        return;
      }
      case 'request-ai-denial-review': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话运行已失效');
        return runner.requestAiDenialReview(call.operationId);
      }
      case 'open-terminal': return this.openTerminal(call.hostId);
      case 'close-terminal':
        this.interactions.cancelForTerminal(call.terminalId);
        for (const runner of this.tasks.values()) if (runner.ownsTerminal(call.terminalId)) runner.stopOperation('terminal-close');
        if (this.terminal.hostOf(call.terminalId)) this.terminal.close(call.terminalId);
        return;
      case 'terminal-input': {
        const taskId = this.terminal.taskOf(call.terminalId);
        const runner = taskId ? this.tasks.get(taskId) : undefined;
        if (call.humanIntent && taskId) {
          if (!runner) throw new Error('对话运行已失效，请重新打开终端');
          return runner.terminalInput(call.terminalId, call.data);
        }
        this.terminal.input(call.terminalId, call.data, call.humanIntent);
        return;
      }
      case 'stop-terminal': {
        const taskId = this.terminal.taskOf(call.terminalId);
        if (taskId) this.tasks.get(taskId)?.terminalInput(call.terminalId, '\u0003');
        else this.terminal.input(call.terminalId, '\u0003', true);
        return;
      }
      case 'resize': return this.terminal.resize(call.terminalId, call.cols, call.rows);
      case 'list-remote': return this.ssh.list(call.hostId, call.path);
      case 'start-task': {
        if (!call.task.session || call.task.session.id !== call.task.id || !call.sessionDirectory) throw new Error('Native session binding required');
        if (!call.restored) this.send({ diagnostic: safeDiagnostic({ event: 'chat', level: 'info', taskId: call.task.id, role: 'user', size: Buffer.byteLength(call.task.goal) }) });
        if (this.tasks.has(call.task.id)) throw new Error('Task is already active');
        const runner = new TaskRunner(call.task, call.hosts, call.profile, call.priorOperations ?? [], this.terminal, this.executor,
          (hostId, taskId) => this.openTerminal(hostId, taskId), {
            budget: (command, signal) => {
              if (!('taskId' in command) || command.taskId !== call.task.id) throw new Error('Budget conversation binding changed');
              return this.budget.request(command, signal);
            },
            clearCredentials: () => this.commands.clearTask(call.task.id),
            cleanupRuntime: async (gate, knownIdle, refresh) => {
              if (!knownIdle) await this.native.markUnknown(undefined, call.task.id);
              await this.native.cleanupTask(call.task.id, gate, refresh);
            },
            abandonRuntime: () => { void this.native.markUnknown(undefined, call.task.id).catch(() => {}); },
            diagnostic: (diagnostic) => this.send({ diagnostic: safeDiagnostic(diagnostic) }),
            event: (event) => this.post({ event } as RuntimeMessage),
            filePreview: (value) => this.send({ filePreview: value }),
            requestApproval: (view) => this.requestApproval(view),
            cancelApproval: (id) => this.cancelApproval(id)
          }, (operationId, cursor) => this.readLog(call.task.id, operationId, cursor), this.privileged.forTask(call.task.id),
          { id: call.task.session.id, directory: call.sessionDirectory, restore: !!call.restored }, {
            inspect: (operation, scriptPath) => this.inspectScript(operation, scriptPath),
            verify: async (operation, scriptPath, sha256) => (await this.inspectScript(operation, scriptPath)).sha256 === sha256
          }, async (operation, gate, signal) => {
            const host = this.hosts.get(operation.scope.hostId);
            await this.privileged.prepareNative(operation, gate, host?.runtimeDirectory, signal);
            if (operation.kind === 'command' || operation.kind === 'runtime') return { operation };
            const remote = this.files(operation).remote;
            return prepareFileOperation(operation, remote, async (upload, abort) =>
              (await new LocalFileAccess(call.task.localScopes ?? []).read(upload.localPath, abort)).data, signal);
          });
        this.tasks.set(call.task.id, runner);
        const start = runner.start(call.restored, call.thinkingLevel, call.document, call.initialMessage, call.intent);
        if (call.restored) {
          try { await start; } catch (error) { this.tasks.delete(call.task.id); runner.dispose(); throw error; }
        }
        else void start.catch((error: unknown) => {
          this.tasks.delete(call.task.id); runner.dispose();
          this.post({ event: { type: 'task-status', taskId: call.task.id, status: 'failed', summary: error instanceof Error ? error.message : String(error) } });
        });
        return;
      }
      case 'authorize-task': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('Task runtime is unavailable; resume it before changing authorization');
        runner.addAuthorization(call.hosts, call.localScopes, call.prepared);
        return;
      }
      case 'answer-clarification':
      case 'cancel-clarification': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话运行已失效，请重新发送需求');
        if (call.method === 'answer-clarification') return runner.answerClarification(call.requestId, call.answers);
        return runner.cancelClarification(call.requestId);
      }
      case 'task-message': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('请先恢复对话');
        if (call.document && this.deliveredMessages.has(call.document.requestId)) return;
        runner.message(call.text, call.document, call.intent, call.preparedRevision);
        if (call.document) this.deliveredMessages.add(call.document.requestId);
        return;
      }
      case 'decide-approval': {
        const pending = this.pendingApprovals.get(call.approvalId);
        if (!pending) throw new Error('Approval expired');
        this.pendingApprovals.delete(call.approvalId);
        pending.resolve(call.approved);
        this.post({ event: { type: 'approval-close', id: call.approvalId } });
        return;
      }
      case 'answer-input': return this.pendingInputs.has(call.requestId)
        ? this.answerInput(call.requestId, call.answer) : this.interactions.answer(call.requestId, call.answer);
      case 'cancel-input': return this.pendingInputs.has(call.requestId)
        ? this.answerInput(call.requestId, null) : this.interactions.cancel(call.requestId);
      case 'pause-task': return this.tasks.get(call.taskId)?.pause();
      case 'resume-task': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('Task runtime is unavailable; reopen the application to reconcile');
        this.resumeTask(runner);
        return;
      }
      case 'delete-task': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) return;
        if (!runner.canDelete) throw new Error('对话仍在运行，无法删除');
        await runner.close();
        this.tasks.delete(call.taskId);
        return;
      }
    }
  }

  private resumeTask(runner: TaskRunner): void {
    void runner.resume().catch((error: unknown) => this.post({ event: {
      type: 'task-status', taskId: runner.task.id, status: 'failed', summary: error instanceof Error ? error.message : String(error)
    } }));
  }

  resolveBudget(result: unknown): void { this.budget.resolve(result); }

  resolveLog(result: { id: string; value?: LogPage; error?: string }): void {
    const pending = this.logRequests.get(result.id);
    if (!pending) return;
    this.logRequests.delete(result.id);
    clearTimeout(pending.timer);
    if (result.value) pending.resolve(result.value);
    else pending.reject(new Error(result.error ?? 'Log unavailable'));
  }

  private readLog(taskId: string, operationId: string, cursor: number): Promise<LogPage> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.logRequests.delete(id); reject(new Error('Log request expired')); }, 5000);
      this.logRequests.set(id, { resolve, reject, timer });
      this.post({ readLog: { id, taskId, operationId, cursor } });
    });
  }

  private requestPrivateInput(request: Omit<InputRequestView, 'id' | 'expiresAt'>, signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    const id = randomUUID(); const expiresAt = Date.now() + 120_000;
    return new Promise((resolve) => {
      const abort = () => { if (this.pendingInputs.has(id)) this.answerInput(id, null); };
      const timeout = setTimeout(abort, 120_000);
      this.pendingInputs.set(id, { connectionId: request.operationId, expiresAt, timeout,
        resolve: (answer) => { signal.removeEventListener('abort', abort); resolve(answer); } });
      signal.addEventListener('abort', abort, { once: true });
      this.post({ event: { type: 'input-open', value: { ...request, id, expiresAt } } });
      if (signal.aborted) abort();
    });
  }

  private async connect(host: RuntimeHost, jump?: RuntimeHost): Promise<void> {
    const connectionId = randomUUID();
    this.hosts.set(host.id, host);
    if (jump) this.hosts.set(jump.id, jump);
    try {
      await this.ssh.connect(host as SshHost, { password: host.secret, passphrase: host.secret },
        jump ? { host: jump as SshHost, secret: { password: jump.secret, passphrase: jump.secret } } : undefined,
        (prompt) => this.requestLoginInput(connectionId, host, prompt));
      this.post({ event: { type: 'host-status', hostId: host.id, status: 'connected' } });
    } catch (error) {
      this.post({ event: { type: 'host-status', hostId: host.id, status: error instanceof HostKeyError ? 'changed-key' : 'error' } });
      throw error;
    } finally {
      for (const [id, pending] of this.pendingInputs) if (pending.connectionId === connectionId) this.answerInput(id, null);
    }
  }

  private requestLoginInput(connectionId: string, host: RuntimeHost, prompt: SshLoginPrompt): Promise<string | null> {
    const id = randomUUID();
    const expiresAt = Date.now() + 120_000;
    const kind = /otp|one.time|verification|验证码|动态码|令牌/u.test(prompt.text.toLowerCase()) ? 'otp'
      : prompt.echo ? 'text' : 'secret';
    const request: InputRequestView = {
      id, taskId: '', operationId: `ssh-login:${connectionId}`, hostId: host.id,
      title: kind === 'otp' ? 'SSH 登录需要验证码' : kind === 'secret' ? 'SSH 登录需要身份验证' : 'SSH 登录需要输入',
      explanation: `正在连接 ${host.label}（${host.address}）并登录账户 ${prompt.username}。服务器通过 SSH 登录认证请求这项信息，回答仅发送给本次认证会话，AI 不会看到。服务器提示：${prompt.text.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 300)}`,
      kind, expiresAt
    };
    this.post({ event: { type: 'input-open', value: request } });
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.answerInput(id, null), 120_000);
      this.pendingInputs.set(id, { connectionId, expiresAt, resolve, timeout });
    });
  }

  private answerInput(id: string, answer: PrivateInputAnswer): void {
    if (!isPrivateInputAnswer(answer)) throw new Error('Invalid private input response');
    const pending = this.pendingInputs.get(id);
    if (!pending) throw new Error('Input request expired');
    this.pendingInputs.delete(id);
    clearTimeout(pending.timeout);
    this.post({ event: { type: 'input-close', id } });
    pending.resolve(Date.now() < pending.expiresAt ? privateAnswerValue(answer) : null);
  }

  private async openTerminal(hostId: string, taskId?: string): Promise<string> {
    const probe = taskId ? await this.ssh.execFixed(hostId, 'pwd -P') : undefined;
    if (probe && (probe.exitCode !== 0 || !probe.output.trim().startsWith('/') || probe.output.trim().includes('\n'))) throw new Error('无法核验 Agent 登录目录');
    if (taskId) return this.terminal.open(hostId, new SshCommandTerminal(this.ssh, hostId), taskId, probe!.output.trim());
    const { channel, nonce } = await this.ssh.integratedShell(hostId);
    let output = (_text: string) => {};
    let command = (_event: Parameters<NonNullable<RawTerminal['onCommand']>>[0] extends (event: infer E) => void ? E : never) => {};
    const decoder = new StringDecoder('utf8');
    const parser = new ShellMarkerParser(nonce, (text) => output(text), (event) => command(event));
    const raw: RawTerminal = {
      human: { open() {}, write: (data) => { channel.write(data); },
        resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
        respondToTerminalQuery: (data) => { channel.write(data); return true; } },
      close: () => channel.end(),
      onCommand: (listener) => { command = listener; },
      onData: (listener) => { output = listener; channel.on('data', (data: Buffer) => parser.push(decoder.write(data))); },
      onClose: (listener) => { channel.on('close', () => { parser.push(decoder.end()); parser.finish(); listener(); }); }
    };
    return this.terminal.open(hostId, raw, taskId, probe?.output.trim() || '/');
  }

  private requestApproval(view: ApprovalView): Promise<boolean> {
    this.post({ event: { type: 'approval-open', value: view } });
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(view.id);
        this.post({ event: { type: 'approval-close', id: view.id } });
        resolve(false);
      }, Math.max(0, view.expiresAt - Date.now()));
      this.pendingApprovals.set(view.id, { taskId: view.taskId, hostId: view.hostId,
        resolve: (allowed) => { clearTimeout(timeout); resolve(allowed); } });
    });
  }

  private cancelApproval(id: string): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    pending.resolve(false);
    this.post({ event: { type: 'approval-close', id } });
  }
}
