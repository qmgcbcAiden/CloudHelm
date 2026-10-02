import { randomUUID } from 'node:crypto';
import { InteractionCoordinator, type InteractionSink, type TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, SshTransport } from '@cloudhelm/adapters';
import { operationFingerprint, type ExecutionOptions, type InputRequest, type OperationExecutor, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import type { ClientChannel } from 'ssh2';
import { aptHasNoRemovals, bridgeCommand, inputPaths, inputPlan, quoteShell, setupInput, supportedSuHost } from './operation-input-plan.js';

/** Fixed authentication helpers own secret input; the shared PTY never receives credentials. */
export class OperationInputBridge implements OperationExecutor {
  private readonly analyzer = new BashAnalyzer();

  constructor(private readonly terminal: TerminalManager, private readonly ssh: SshTransport,
    private readonly interactions: InteractionCoordinator,
    private readonly onAutoConfirmation?: (taskId: string, hostId: string) => void) {}

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (operation.kind !== 'command') return this.terminal.execute(operation, fingerprint, signal, options);
    const hostId = operation.scope.hostId;
    const connectionGeneration = this.ssh.connectionGeneration(hostId);
    const current = () => !signal?.aborted && operationFingerprint(operation) === fingerprint
      && options?.isAuthorized?.() !== false
      && this.terminal.hostOf(operation.scope.terminalId) === hostId
      && this.terminal.taskOf(operation.scope.terminalId) === operation.scope.taskId
      && this.terminal.isAgentOwner(operation.scope.terminalId)
      && this.terminal.currentGeneration(operation.scope.terminalId) === operation.scope.terminalGeneration
      && this.ssh.connectionGeneration(hostId) === connectionGeneration;
    if (!current()) throw new Error('Operation authorization expired before input bridge setup');
    const analysis = await this.analyzer.analyze(operation.command);
    if (analysis.hasError) throw new Error('Cannot bridge an incomplete command parse');
    if (!current()) throw new Error('Operation authorization expired during analysis');
    const plan = inputPlan(analysis);
    if (!plan) {
      if (analysis.calls.some((call) => /(?:^|\/)(?:sudo|su)$/u.test(call.name))) {
        this.terminal.suspend(operation.scope.terminalId);
        return { operationId: operation.id, status: 'failed', stdoutTail: 'This authentication form requires manual takeover; no command was sent.' };
      }
      return this.terminal.execute(operation, fingerprint, signal, options);
    }
    if (plan.auth === 'su') {
      const probe = await this.ssh.execFixed(hostId, `/usr/bin/su --version; /usr/bin/setsid --version; /usr/bin/getent passwd ${quoteShell(plan.user!)}; /usr/bin/getent shells; test -x /bin/sh && test -x /bin/bash && test -d /proc/self/fd`);
      if (!current()) throw new Error('Operation authorization expired during capability detection');
      if (probe.exitCode !== 0 || !supportedSuHost(probe.output, plan.user!)) {
        this.terminal.suspend(operation.scope.terminalId);
        return { operationId: operation.id, status: 'failed', stdoutTail: 'Automatic su requires util-linux su/setsid and a recognized unrestricted target shell. Use manual takeover on this host.' };
      }
    }
    if (!current()) throw new Error('Operation authorization expired during capability detection');
    const token = randomUUID().replace(/-/gu, '');
    const paths = inputPaths(token);
    const authPrompt = `__CLOUDHELM_AUTH_${token}__`;
    const authEnd = `__CLOUDHELM_AUTH_END_${token}__`;
    const setup = await this.ssh.execFixed(hostId, setupInput(paths, authPrompt));
    if (setup.exitCode !== 0) return { operationId: operation.id, status: 'failed', stdoutTail: 'Could not create a private operation input bridge.' };

    let active = true;
    let authActive = !!plan.auth;
    let waiting: 'secret' | 'confirmation' | undefined;
    let attempts = 0;
    let authenticated = () => {};
    let cleanupPromise: Promise<void> | undefined;
    const channels: ClientChannel[] = [];
    let unsubscribe = () => {};
    const cancel = () => {
      if (!active) return;
      this.interactions.cancelForTerminal(operation.scope.terminalId);
      if (this.terminal.isAgentOwner(operation.scope.terminalId)) this.terminal.suspend(operation.scope.terminalId);
      void cleanup();
    };
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      active = false;
      authActive = false;
      waiting = undefined;
      clearTimeout(authDeadline);
      clearInterval(leaseCheck);
      signal?.removeEventListener('abort', cancel);
      unsubscribe();
      this.interactions.cancelForTerminal(operation.scope.terminalId);
      // Close only short-lived input helpers, never signal or kill the reviewed remote command.
      for (const channel of channels) { channel.end(); channel.close(); }
      cleanupPromise = this.ssh.connectionGeneration(hostId) === connectionGeneration
        ? this.ssh.execFixed(hostId, `rm -f -- ${[paths.secret, paths.prompt, paths.normal, paths.askpass].map(quoteShell).join(' ')}; rmdir -- ${quoteShell(paths.directory)}`).then(() => undefined, () => undefined)
        : Promise.resolve();
      return cleanupPromise;
    };
    const authDeadline = plan.auth ? setTimeout(cancel, 120_000) : undefined;
    const leaseCheck = setInterval(() => { if (!current()) cancel(); }, 100);
    signal?.addEventListener('abort', cancel, { once: true });

    const open = async (command: string): Promise<ClientChannel> => {
      if (!active || !current()) throw new Error('Input bridge authorization expired');
      const channel = await this.ssh.openPipe(hostId, command);
      if (!active || !current()) { channel.end(); channel.close(); throw new Error('Input bridge authorization expired'); }
      channels.push(channel);
      channel.on('error', cancel);
      return channel;
    };
    try {
      // The prompt relay exits when this SSH channel receives EOF; only its own cat
      // child is stopped. No PID belonging to the reviewed operation is touched.
      const prompts = await open(`exec 3<> ${quoteShell(paths.prompt)}; cat <&3 & relay=$!; read -r unused; kill "$relay" 2>/dev/null; wait "$relay" 2>/dev/null`);
      // Opening read/write avoids leaving a helper blocked in open() if auth never starts.
      const secret = await open(`exec 3<> ${quoteShell(paths.secret)}; cat >&3`);
      const normal = await open(`exec 3<> ${quoteShell(paths.normal)}; cat >&3`);
      const sink: InteractionSink = {
        isWaiting: (request) => active && current() && waiting === request.kind
          && request.operationId === operation.id && request.connectionGeneration === connectionGeneration
          && (request.kind !== 'secret' || authActive),
        deliver: async (request, answer) => {
          if (!sink.isWaiting(request) || answer.length > 4095 || /[\r\n\u0000]/u.test(answer)) return false;
          const destination = request.kind === 'secret' ? secret : normal;
          waiting = undefined;
          try { destination.write(`${answer}\n`); return true; }
          catch { cancel(); return false; }
        }
      };
      const requestSecret = () => {
        if (!active || !current() || !authActive) return;
        if (waiting || ++attempts > 3) { cancel(); return; }
        waiting = 'secret';
        const goal = operation.scope.goal.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
        const purpose = goal.length > 160 ? `${goal.slice(0, 160)}…` : goal;
        const account = operation.scope.runAs.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 80);
        const reason = plan.auth === 'su'
          ? `为了完成“${purpose}”，当前 SSH 连接账户 ${account} 的已审核操作需要切换为 ${plan.user}。请输入目标账户 ${plan.user} 的密码；验证后继续本次操作。密码只进入独立认证通道，业务命令和 AI 不会收到。`
          : `为了完成“${purpose}”，当前 SSH 连接账户 ${account} 的已审核操作需要 sudo 授权。请输入 sudo 所要求的账户密码／授权身份；验证后继续本次操作。密码只进入独立认证通道，业务命令和 AI 不会收到。`;
        const details: Omit<InputRequest, 'id' | 'expiresAt'> = {
          taskId: operation.scope.taskId, operationId: operation.id, hostId,
          terminalId: operation.scope.terminalId, terminalGeneration: operation.scope.terminalGeneration,
          connectionGeneration, kind: 'secret', recipient: plan.auth === 'su' ? `su (${plan.user})` : 'sudo',
          reason,
          prompt: `${plan.auth} 身份验证`
        };
        void this.interactions.request(details, sink).then((status) => {
          if (status !== 'submitted' && active && authActive) cancel();
        }).catch(cancel);
      };
      let promptTail = '';
      prompts.on('data', (data: Buffer | string) => {
        if (!active || !authActive) return;
        promptTail = (promptTail + data.toString()).slice(-4096);
        if (promptTail.includes(`${authEnd}\n`)) {
          authActive = false;
          clearTimeout(authDeadline);
          waiting = undefined;
          this.interactions.cancelForTerminal(operation.scope.terminalId);
          authenticated();
          return;
        }
        if (plan.auth === 'sudo' && promptTail.includes(`${authPrompt}\n`)) {
          promptTail = ''; requestSecret();
        } else if (plan.auth === 'su' && /(?:^|[\r\n])Password:\s*$/u.test(promptTail)) {
          promptTail = ''; requestSecret();
        } else if (plan.auth === 'su' && /(?:new password|current password|verification|authentication token|expired)/iu.test(promptTail)) cancel();
      });
      prompts.on('close', cancel);
      secret.on('close', () => { if (active && authActive) cancel(); });
      normal.on('close', () => { if (active && plan.aptInstall) cancel(); });
      let output = '';
      let confirmed = false;
      const confirmApt = () => {
        if (!active || !plan.aptInstall || authActive || !current() || confirmed) return;
        if (!/Do you want to continue\?\s*\[Y\/n\]\s*$/u.test(output)) return;
        // Changed impacts end this attempt; the next proposed operation must pass SafetyGate again.
        try {
          if (!aptHasNoRemovals(output)) { normal.write('n\n'); cancel(); return; }
          confirmed = true;
          normal.write('y\n');
          this.onAutoConfirmation?.(operation.scope.taskId, hostId);
        } catch { cancel(); }
      };
      authenticated = confirmApt;
      unsubscribe = this.terminal.subscribeData(operation.scope.terminalId, (data) => {
        output = (output + data).slice(-8192);
        confirmApt();
      });
      if (!current()) throw new Error('Operation authorization expired before execution');
      const wrapped = { ...operation, command: bridgeCommand(plan, paths, authEnd) };
      const result = await this.terminal.execute(wrapped, operationFingerprint(wrapped), signal, options);
      await cleanup();
      return result;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}
