import path from 'node:path';
import type { NativeRuntimePreparation } from './native-runtime-preparation.js';
import type { FileExecutionFactory } from './file-operation-executor.js';
import { buildCommandExecutionPlan, isEffectFreeQuery, type RuntimeOperationPlan } from '@cloudhelm/core';
import { randomUUID } from 'node:crypto';
import { PrivilegedSessions, type SafetyGate, type TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, SshCommandTerminal, SshTransport, SuSession } from '@cloudhelm/adapters';
import { PrivilegeError, sudoContextCommand, type PrivilegeMethod } from '@cloudhelm/core';
import type { AgentExecutionPort, ExecutionOptions, OperationExecutor, OperationResult, OperationIntent, OperationScope, ProposedOperation, RawTerminal } from '@cloudhelm/core';
import type { InputRequestView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import { FileOperationExecutor } from './file-operation-executor.js';

class DeferredTerminal implements RawTerminal {
  readonly agent: AgentExecutionPort = {
    execute: (...args) => this.execute(...args), onExit: (listener) => this.onExit(listener),
    onExecutionFailure: (listener) => this.onExecutionFailure(listener), onAuthentication: (listener) => this.onAuthentication(listener),
    answerAuthentication: (...args) => this.answerAuthentication(...args),
    confirmInput: (...args) => this.target?.agent?.confirmInput?.(...args) ?? false,
    interrupt: (id) => this.target?.agent?.interrupt?.(id) ?? false,
    respondToTerminalQuery: (...args) => this.target?.agent?.respondToTerminalQuery?.(...args) ?? false,
    resize: (...args) => this.target?.agent?.resize?.(...args)
  };
  target?: RawTerminal;
  private data = (_value: string) => {};
  private display = (_value: string) => {};
  private failure = (_failure: Pick<OperationResult, 'failureKind' | 'effects' | 'privilege'>) => {};
  private exit = (_value: number | undefined) => {};
  private authentication = (_value: { id: string; prompt?: string }) => {};
  private closed = () => {};
  private ended = false;
  constructor(private readonly revoke: () => void) {}
  attach(target: RawTerminal): void {
    if (this.ended) { target.close(); throw new Error('Root terminal closed'); }
    this.target = target; target.onData(this.data); target.onDisplay?.(this.display);
    target.agent?.onExecutionFailure?.(this.failure); target.agent?.onExit?.(this.exit); target.agent?.onAuthentication?.(this.authentication); target.onClose(() => this.finishClose());
  }
  onData(listener: (value: string) => void): void { this.data = listener; }
  onDisplay(listener: (value: string) => void): void { this.display = listener; }
  onExecutionFailure(listener: typeof this.failure): void { this.failure = listener; }
  onExit(listener: (value: number | undefined) => void): void { this.exit = listener; }
  onAuthentication(listener: typeof this.authentication): void { this.authentication = listener; this.target?.agent?.onAuthentication?.(listener); }
  answerAuthentication(id: string, answer: string | null): boolean { return this.target?.agent?.answerAuthentication?.(id, answer) ?? false; }
  onClose(listener: () => void): void { this.closed = listener; }
  execute(command: string, cwd: string, current: () => boolean, context?: import('@cloudhelm/core').RawTerminalExecutionContext): Promise<void> {
    if (!this.target?.agent) throw new Error('Root session not authenticated');
    return this.target.agent.execute(command, cwd, current, context);
  }
  takeOver(): void { queueMicrotask(this.revoke); }
  close(): void { this.target?.close(); this.finishClose(); }
  private finishClose(): void {
    if (this.ended) return;
    this.ended = true; this.closed(); this.revoke();
  }
}
interface Entry {
  id: string; taskId: string; host: RuntimeHost; mode: PrivilegeMethod; terminalId: string;
  raw: DeferredTerminal; controller: AbortController; sourceGeneration: number;
  transportController: AbortController;
  ssh?: SshTransport; su?: SuSession; executor?: OperationExecutor; probeId: string; runtimePlan?: RuntimeOperationPlan;
}
interface Dependencies {
  terminal: TerminalManager; ssh: SshTransport; ordinary: OperationExecutor; commands: OperationExecutor;
  runtime: NativeRuntimePreparation; files: FileExecutionFactory;
  jump(host: RuntimeHost): RuntimeHost | undefined;
  input(request: Omit<InputRequestView, 'id' | 'expiresAt'>, signal: AbortSignal): Promise<string | null>;
}

/** Desktop assembly routes application-owned grants to isolated adapter transports. */
export class PrivilegedRuntime implements OperationExecutor {
  private readonly grants = new PrivilegedSessions();
  private readonly entries = new Map<string, Entry>();
  private readonly requesting = new Map<string, AbortController>();
  constructor(private readonly deps: Dependencies) {}

  forTask(taskId: string): PrivilegedTaskAccess {
    return {
      request: (host, command, cwd, reason, goal, gate, signal, intent, method, purpose, policy) => this.request(taskId, host, command, cwd, reason, goal, gate, signal, intent, method, purpose, policy),
      prepare: async (operation) => { if (operation.scope.taskId !== taskId) throw new Error('Context outside task'); return this.prepare(operation); },
      sudoContexts: () => [...this.entries.values()].flatMap((entry) => {
        try {
          if (entry.mode !== 'sudo' || entry.taskId !== taskId) return [];
          this.grants.get(entry.id, taskId, entry.host.id);
          if (!this.deps.terminal.isAgentOwner(entry.terminalId) || entry.sourceGeneration !== this.deps.ssh.connectionGeneration(entry.host.id)) return [];
          return [{ sessionId: entry.id, hostId: entry.host.id, state: 'prepared' as const, loginAs: entry.host.username, targetRunAs: 'root' as const }];
        } catch { return []; }
      }),
      terminal: (id, hostId) => { this.grants.get(id, taskId, hostId); return this.entries.get(id)!.terminalId; },
      scope: (terminalId) => {
        const entry = [...this.entries.values()].find((e) => e.taskId === taskId && e.terminalId === terminalId);
        if (!entry) return {};
        this.grants.get(entry.id, taskId, entry.host.id, true);
        return { sessionId: entry.id, loginAs: entry.mode === 'ssh' ? 'root' : entry.host.username, runAs: 'root', connectionGeneration: 1 };
      },
      owns: (terminalId) => [...this.entries.values()].some((e) => e.taskId === taskId && e.terminalId === terminalId),
      confirmed: () => [...this.entries.values()].flatMap((entry) => {
        try {
          if (entry.mode === 'sudo') return [];
          this.grants.get(entry.id, taskId, entry.host.id);
          if (!this.deps.terminal.isAgentOwner(entry.terminalId)
            || entry.sourceGeneration !== this.deps.ssh.connectionGeneration(entry.host.id)) return [];
          return [{ sessionId: entry.id, hostId: entry.host.id, method: entry.mode, runAs: 'root' as const }];
        } catch { return []; } // Projection never grants/revives a session on inspection failure.
      }),
      close: () => this.closeTask(taskId)
    };
  }

  private async request(taskId: string, host: RuntimeHost, command: string, cwd: string, reason: string, goal: string,
    gate: SafetyGate, signal?: AbortSignal, intent?: OperationIntent, method: PrivilegeMethod = 'sudo', purpose: 'execute' | 'recover' = 'execute',
    policy?: Pick<OperationScope, 'conversationRevision' | 'reviewerRevision'>): ReturnType<PrivilegedTaskAccess['request']> {
    if (this.requesting.has(taskId)) throw new Error('Root session request already pending');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.requesting.set(taskId, controller);
    let entry: Entry | undefined;
    try {
      signal?.throwIfAborted();
      const probeId = randomUUID();
      const sourceGeneration = this.deps.ssh.connectionGeneration(host.id);
      const choice = await this.deps.input({ taskId, hostId: host.id, operationId: probeId, kind: 'confirmation',
        title: '确认提权方式（默认 sudo）', choices: method === 'ssh' ? ['SSH 登录 root'] : method === 'su' ? ['通过 su 切换 root'] : ['使用 sudo（推荐）', 'SSH 登录 root', '通过 su 切换 root'],
        explanation: `主机：${host.label}（${host.address}:${host.port}）\n原因：${reason}\n目录：${cwd}\n待执行操作：${command}\n默认 sudo 逐条提权，不创建通用 root Shell，不执行上述操作或探测权限。root SSH须服务器允许；直接su通常需要root密码，不是登录用户的sudo密码。不知道root密码请选择sudo或取消。所有后续操作仍逐条审核。` }, controller.signal);
      controller.signal.throwIfAborted();
      if (!['使用 sudo（推荐）', 'SSH 登录 root', '通过 su 切换 root'].includes(choice ?? '')) throw new PrivilegeError({ method, stage: 'preparation', code: 'cancelled', source: 'transport', businessCommand: 'not-started', recovery: 'user-action' });
      if ((method === 'ssh' && choice !== 'SSH 登录 root') || (method === 'su' && choice !== '通过 su 切换 root')) throw new Error('Unconfirmed privilege method');
      if (sourceGeneration !== this.deps.ssh.connectionGeneration(host.id)) throw new Error('SSH connection changed during confirmation');
      const grant = this.grants.begin(taskId, host.id, choice === '使用 sudo（推荐）' ? 'sudo' : choice === 'SSH 登录 root' ? 'ssh' : 'su');
      const raw = new DeferredTerminal(() => this.close(grant.id));
      const terminalId = this.deps.terminal.open(host.id, raw, taskId, cwd);
      entry = { id: grant.id, taskId, host, mode: grant.mode, raw, terminalId, controller: grant.controller,
        transportController: new AbortController(), sourceGeneration, probeId };
      this.entries.set(entry.id, entry);
      if (entry.mode === 'sudo') {
        entry.executor = this.deps.ordinary;
        raw.attach(new SshCommandTerminal(this.deps.ssh, host.id));
        controller.signal.throwIfAborted();
        return { sessionId: entry.id, method: 'sudo', state: 'prepared', loginAs: host.username, targetRunAs: 'root', identityVerified: false };
      }
      const stop = () => this.close(grant.id);
      controller.signal.addEventListener('abort', stop, { once: true });
      try {
        const probe: ProposedOperation = { id: probeId, kind: 'command', command: 'id -u', scope: {
          taskId, hostId: host.id, terminalId, terminalGeneration: this.deps.terminal.currentGeneration(terminalId),
          cwd, runAs: 'root', loginAs: entry.mode === 'ssh' ? 'root' : host.username, sessionId: entry.id, connectionGeneration: 1,
          ...policy, policyRevision: host.policyRevision, allowedWorkingRoots: ['/'], protectedPaths: [...host.protectedPaths],
          protectedReadPaths: [...(host.protectedReadPaths ?? host.protectedPaths)],
          protectedWritePaths: [...(host.protectedWritePaths ?? host.protectedPaths)], goal, intent
        } };
        probe.executionPlan = buildCommandExecutionPlan(await new BashAnalyzer().analyze(probe.command), 'root');
        const current = () => {
          controller.signal.throwIfAborted();
          if (entry!.sourceGeneration !== this.deps.ssh.connectionGeneration(host.id)
            || !this.deps.terminal.isAgentOwner(terminalId)) throw new Error('Root setup expired');
          this.grants.get(entry!.id, taskId, host.id, true);
        };
        if (entry.mode === 'ssh') {
          await this.authenticate(entry, current);
          await this.deps.runtime.ensure(probe, gate, entry.ssh!, host.runtimeDirectory, controller.signal, purpose);
        } else {
          const info = await this.deps.runtime.ensure(probe, gate, this.deps.ssh, host.runtimeDirectory, controller.signal, purpose);
          const directory = path.posix.join(host.runtimeDirectory ?? '/tmp', `cloudhelm-root-${randomUUID()}`);
          entry.runtimePlan = { version: 1, action: 'su-bootstrap', directory, executable: `${directory}/helper`,
            artifact: info.artifact, sessionId: entry.id, purpose: 'execute', parentOperationId: probeId };
          await this.deps.runtime.bootstrap(probe, entry.runtimePlan, gate, this.deps.ssh,
            (runtimeCurrent) => this.authenticate(entry!, () => { current(); runtimeCurrent(); }), controller.signal);
        }
        const outcome = await gate.execute(probe, controller.signal);
        if (outcome.result?.status !== 'succeeded' || outcome.result.stdoutTail.trim() !== '0') {
          if (outcome.result?.privilege) throw new PrivilegeError(outcome.result.privilege);
          throw new Error('Root identity could not be verified; session closed');
        }
        this.grants.activate(entry.id, taskId, host.id);
        return { sessionId: entry.id, method: entry.mode, runAs: 'root' };
      } finally { controller.signal.removeEventListener('abort', stop); }
    } catch (error) {
      if (entry) {
        try { this.close(entry.id); }
        finally { if (purpose === 'recover') await this.deps.runtime.abandonSession(taskId, entry.id); }
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.requesting.get(taskId) === controller) this.requesting.delete(taskId);
    }
  }

  private async prepare(operation: ProposedOperation): Promise<ProposedOperation> {
    if (!operation.scope.sessionId) return operation;
    const entry = this.entries.get(operation.scope.sessionId);
    const check = () => {
      if (!entry || entry.controller.signal.aborted || entry.sourceGeneration !== this.deps.ssh.connectionGeneration(entry.host.id)
        || entry.terminalId !== operation.scope.terminalId || !this.deps.terminal.isAgentOwner(entry.terminalId)) throw new Error('Privilege context expired');
      this.grants.get(entry.id, operation.scope.taskId, operation.scope.hostId);
    };
    check();
    if (entry!.mode !== 'ssh' && operation.kind !== 'command') throw new Error('Structured file transactions require login or root SSH identity; no file operation sent. Use ordinary-account nonsecret staging and separately reviewed commands.');
    if (entry!.mode !== 'sudo' || operation.kind !== 'command') return operation;
    const command = sudoContextCommand(await new BashAnalyzer().analyze(operation.command));
    check();
    return { ...operation, command, scope: { ...operation.scope, loginAs: entry!.host.username, runAs: 'root' } };
  }

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (!operation.scope.sessionId) return this.deps.ordinary.execute(operation, fingerprint, signal, options);
    const entry = this.entries.get(operation.scope.sessionId);
    const current = () => {
      if (!entry || entry.controller.signal.aborted || signal?.aborted || options?.isAuthorized?.() === false
        || entry.sourceGeneration !== this.deps.ssh.connectionGeneration(entry.host.id)
        || operation.scope.terminalId !== entry.terminalId || !operation.scope.runAs
        || operation.scope.loginAs !== (entry.mode === 'ssh' ? 'root' : entry.host.username) || operation.scope.connectionGeneration !== 1) throw new Error('Root operation authorization expired');
      this.grants.get(entry.id, operation.scope.taskId, operation.scope.hostId, operation.id === entry.probeId);
    };
    current();
    const active = entry!;
    if (active.mode === 'sudo') {
      if (operation.kind !== 'command') return { operationId: operation.id, status: 'failed', failureKind: 'unsupported', effects: 'none',
        stdoutTail: 'Structured file transactions do not use sudo. Stage nonsecret files as the login user, then submit a separately reviewed sudo install command.' };
      try {
        if (sudoContextCommand(await new BashAnalyzer().analyze(operation.command)) !== operation.command) throw new Error('Unprepared');
      } catch { return { operationId: operation.id, status: 'failed', failureKind: 'unsupported', effects: 'none',
        stdoutTail: 'Unprepared sudo operation refused before dispatch. Submit a supported literal command through the normal tool preparation and review.' }; }
      current();
    }
    if (!active.executor) return { operationId: operation.id, status: 'failed', effects: 'none', failureKind: 'unsupported',
      stdoutTail: 'Root runtime has not been prepared and reviewed; business operation not started.' };
    current();
    return active.executor!.execute(operation, fingerprint, signal, options);
  }

  private async authenticate(entry: Entry, current: () => void): Promise<void> {
    const input = async (title: string, explanation: string, kind: InputRequestView['kind'] = 'secret') => {
      const answer = await this.deps.input({ taskId: entry.taskId, hostId: entry.host.id, operationId: entry.probeId, title, explanation, kind }, entry.controller.signal);
      if (answer === null) throw new PrivilegeError({ method: entry.mode, stage: 'authentication', code: 'cancelled', source: 'transport', businessCommand: 'not-started', recovery: 'user-action' });
      return answer;
    };
    let transport: SshTransport | SuSession;
    if (entry.mode === 'ssh') {
      const ssh = new SshTransport(() => this.close(entry.id)); entry.ssh = ssh;
      const host = { ...entry.host, username: 'root', secret: undefined };
      // Existing key/agent selection may be used, but never reuse the login account's saved password.
      let secret: string | null = null;
      if (host.auth === 'password') secret = await input('root SSH 密码', `接收方：${host.address}:${host.port} 的 root SSH 认证。本次不保存凭据。`);
      if (host.auth === 'private-key') {
        const choice = await this.deps.input({ taskId: entry.taskId, hostId: host.id, operationId: entry.probeId,
          kind: 'confirmation', title: 'root SSH 私钥口令', explanation: '使用此主机已选择的私钥文件，以 root 身份认证。',
          choices: ['私钥无口令', '输入私钥口令'] }, entry.controller.signal);
        if (choice === '私钥无口令') secret = '';
        else if (choice === '输入私钥口令') secret = await input('root SSH 私钥口令', '口令仅交给本次 SSH 认证，不保存。');
        else throw new Error('Root login canceled');
      }
      if (host.auth !== 'agent' && secret === null) throw new Error('Root login canceled');
      current();
      const jump = this.deps.jump(host);
      try { await ssh.connect(host, { password: secret ?? undefined, passphrase: secret ?? undefined },
        jump ? { host: jump, secret: { password: jump.secret, passphrase: jump.secret } } : undefined,
        (challenge) => {
          const recipient = challenge.hostId === host.id ? host : jump;
          if (!recipient || recipient.id !== challenge.hostId || recipient.username !== challenge.username) return Promise.resolve(null);
          return this.deps.input({ taskId: entry.taskId, hostId: recipient.id, operationId: entry.probeId,
            title: 'SSH 追加认证', explanation: `接收方：${recipient.address}:${recipient.port} 的 ${challenge.username} SSH 认证。`,
            kind: /otp|verification|one.time/iu.test(challenge.text) ? 'otp' : 'secret' }, entry.controller.signal);
        }, entry.controller.signal); }
      catch (error) {
        if (error instanceof PrivilegeError) throw error;
        const rejected = error && typeof error === 'object' && 'level' in error && error.level === 'client-authentication';
        throw new PrivilegeError({ method: 'ssh', stage: 'authentication', code: rejected ? 'authentication-rejected' : 'authentication-unconfirmed',
          source: 'transport', businessCommand: 'not-started', recovery: 'user-action' });
      }
      transport = ssh;
      entry.executor = new FileOperationExecutor(this.deps.terminal, ssh, this.deps.commands, this.deps.files);
    } else {
      const su = new SuSession(this.deps.ssh, entry.host.id, entry.transportController.signal, () => this.close(entry.id)); entry.su = su;
      await su.connect(() => input('su root 身份验证（root 密码）', `接收方：${entry.host.label} 上本次操作的 su 认证进程。通常需要 root 账户密码，不是 ${entry.host.username} 的 sudo 密码。不知道 root 密码请取消，明确选择 sudo。密码不会发送给业务命令。`), current, { version: 1, sessionId: entry.id, operationId: entry.probeId, generation: 1,
        rootDirectory: entry.runtimePlan!.directory, artifactSha256: entry.runtimePlan!.artifact.sha256 });
      transport = su;
      entry.executor = { execute: (operation, fingerprint, signal, options) => operation.kind === 'command'
        ? this.deps.commands.execute(operation, fingerprint, signal, options)
        : Promise.resolve({ operationId: operation.id, status: 'failed', failureKind: 'unsupported', effects: 'none',
          stdoutTail: 'Structured file transactions do not use su. Stage nonsecret content with the ordinary account, then use a separately reviewed root install command.' }) };
    }
    current();
    entry.raw.attach(new SshCommandTerminal(transport, entry.host.id));
  }

  fileTransport(operation: ProposedOperation): SshTransport {
    if (!operation.scope.sessionId) return this.deps.ssh;
    const entry = this.entries.get(operation.scope.sessionId);
    if (!entry || entry.taskId !== operation.scope.taskId || entry.host.id !== operation.scope.hostId) throw new Error('Privilege context expired');
    this.grants.get(entry.id, entry.taskId, entry.host.id);
    if (entry.mode !== 'ssh' || !entry.ssh) throw new Error('Structured files require login or root SSH identity');
    return entry.ssh;
  }

  async prepareNative(operation: ProposedOperation, gate: SafetyGate, base?: string, signal?: AbortSignal): Promise<void> {
    const entry = operation.scope.sessionId ? this.entries.get(operation.scope.sessionId) : undefined;
    const purpose = operation.kind === 'command' && isEffectFreeQuery(await new BashAnalyzer().analyze(operation.command)) ? 'recover' : 'execute';
    if (entry?.mode === 'su') {
      if (!entry.runtimePlan) throw new Error('Root runtime unavailable');
      await this.deps.runtime.bootstrap(operation, { ...entry.runtimePlan, action: 'launch', purpose, parentOperationId: operation.id },
        gate, this.deps.ssh, async () => {}, signal);
    } else await this.deps.runtime.ensure(operation, gate, entry?.ssh ?? this.deps.ssh, base, signal, purpose);
  }

  private close(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    const closeTransport = () => { entry.transportController.abort(); entry.su?.close(); entry.ssh?.close(); };
    const retained = this.deps.runtime.retireSession(entry.taskId, entry.id, closeTransport,
      entry.su ? (current) => entry.su!.cleanupRuntime(current) : undefined);
    this.grants.close(id);
    try { if (this.deps.terminal.hostOf(entry.terminalId)) this.deps.terminal.close(entry.terminalId); }
    finally { if (!retained) closeTransport(); }
  }
  private closeTask(taskId: string): void {
    this.requesting.get(taskId)?.abort();
    for (const entry of this.entries.values()) if (entry.taskId === taskId) this.close(entry.id);
    this.grants.closeTask(taskId);
  }
}
