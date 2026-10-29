import { InteractionCoordinator, SudoCredentialCache, type InteractionSink, type TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, SshTransport } from '@cloudhelm/adapters';
import { describeSudoOutcome, isSudoStatusProbe, isSudo, operationFingerprint, privateAnswerValue, sanitizeAuthenticationPrompt,
  type ExecutionOptions, type InputRequest, type OperationExecutor, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import { aptHasNoRemovals, inputPlan } from './operation-input-plan.js';

/** The reviewed command remains unchanged. Only the process transport owns sudo's credential channel. */
export class OperationInputBridge implements OperationExecutor {
  private readonly analyzer = new BashAnalyzer();
  private readonly credentials = new SudoCredentialCache();
  clearTask(taskId: string): void { this.credentials.clearTask(taskId); }
  clearTerminal(terminalId: string): void { this.credentials.clearTerminal(terminalId); }
  clearHost(hostId: string): void { this.credentials.clearHost(hostId); }

  constructor(private readonly terminal: TerminalManager, private readonly ssh: SshTransport,
    private readonly interactions: InteractionCoordinator,
    private readonly onAutoConfirmation?: (taskId: string, hostId: string) => void,
    private readonly onCredentialReuse?: (taskId: string, hostId: string, operationId: string) => void) {}

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (operation.kind !== 'command') return this.terminal.execute(operation, fingerprint, signal, options);
    const { hostId, terminalId, taskId, terminalGeneration } = operation.scope;
    const connectionGeneration = this.ssh.connectionGeneration(hostId);
    const current = () => !signal?.aborted && operationFingerprint(operation) === fingerprint
      && options?.isAuthorized?.() !== false && this.terminal.hostOf(terminalId) === hostId
      && this.terminal.taskOf(terminalId) === taskId && this.terminal.isAgentOwner(terminalId)
      && this.terminal.currentGeneration(terminalId) === terminalGeneration
      && this.ssh.connectionGeneration(hostId) === connectionGeneration;
    if (!current()) throw new Error('Operation authorization expired');
    const analysis = await this.analyzer.analyze(operation.command);
    if (analysis.hasError) throw new Error('Cannot authenticate an incomplete command parse');
    if (!current()) throw new Error('Operation authorization expired during analysis');
    if (isSudoStatusProbe(analysis)) return { operationId: operation.id, status: 'failed', failureKind: 'unsupported', effects: 'none',
      stdoutTail: 'No command sent. sudo status/list/validate probes are not supported by isolated per-operation authentication and do not establish whether the next sudo command can work. Execute the actual bounded sudo operation through normal review; the private authentication channel will request input when needed. This is a recoverable tool limitation, not an authentication rejection.' };
    const plan = inputPlan(analysis);
    if (!plan) {
      if (analysis.calls.some((call) => /(?:^|\/)(?:sudo|su)$/u.test(call.name))) {
        this.terminal.suspend(terminalId);
        return { operationId: operation.id, status: 'failed', requiresUserAction: true, failureKind: 'unsupported', effects: 'none',
          stdoutTail: 'This authentication form requires manual takeover; no command was sent. Do not wrap it or switch tools to bypass this result.' };
      }
      try {
        const result = await this.terminal.execute(operation, fingerprint, signal, options);
        if (result.status !== 'succeeded') this.credentials.clearTask(taskId);
        return result;
      } catch (error) { this.credentials.clearTask(taskId); throw error; }
    }
    const policy = operation.scope.sudoCachePolicy;
    const singleSudo = analysis.steps?.length === 1 && isSudo(analysis.steps[0]!.call);
    const cachingEnabled = singleSudo && policy?.mode === 'single-password-auto';
    const binding = { ...operation.scope, connectionGeneration, cachePolicyRevision: policy?.revision ?? 0, prompt: '' };
    if (!cachingEnabled) this.credentials.clearTerminal(terminalId);
    let lastAnswer: Buffer | undefined;
    const dropAnswer = () => { lastAnswer?.fill(0); lastAnswer = undefined; };
    let active = true;
    let interrupted: OperationResult['privilege'];
    let waiting: string | undefined;
    let attempts = 0;
    const processChallenges = new Map<string, number>();
    const maxAttempts = 3;
    const cancel = (code: 'cancelled' | 'timeout' | 'attempts-exhausted' | 'transport-unavailable' = 'cancelled') => {
      if (!active) return;
      if (plan.auth) interrupted ??= { method: 'sudo', stage: 'authentication', code, source: 'transport', businessCommand: 'unknown', recovery: 'user-action' };
      this.credentials.clearTask(taskId); dropAnswer();
      if (waiting && this.terminal.hostOf(terminalId) === hostId) this.terminal.answerAuthentication(terminalId, operation.id, waiting, null);
      waiting = undefined;
      this.interactions.cancelForTerminal(terminalId);
      if (this.terminal.isAgentOwner(terminalId)) this.terminal.suspend(terminalId);
    };
    const unsubscribeAuth = this.terminal.subscribeAuthentication(terminalId, (challenge) => {
      if (!active) return;
      if (challenge.prompt === undefined) {
        if (waiting === challenge.id) { waiting = undefined; this.interactions.cancelForTerminal(terminalId); }
        return;
      }
      attempts++;
      const processId = challenge.processId ?? operation.id;
      const processAttempts = (processChallenges.get(processId) ?? 0) + 1;
      processChallenges.set(processId, processAttempts);
      if (!plan.auth || (challenge.mechanism && challenge.mechanism !== 'sudo') || !current() || waiting || processAttempts > maxAttempts) {
        this.terminal.answerAuthentication(terminalId, operation.id, challenge.id, null);
        cancel(processAttempts > maxAttempts ? 'attempts-exhausted' : 'transport-unavailable'); return;
      }
      waiting = challenge.id;
      const prompt = sanitizeAuthenticationPrompt(challenge.prompt);
      const promptBinding = challenge.promptSha256 === undefined ? `text:${prompt}`
        : /^[a-f0-9]{64}$/u.test(challenge.promptSha256) ? `sha256:${challenge.promptSha256}` : '';
      // A second challenge can be MFA or a retry. Neither proves a reusable password.
      if (attempts > 1 || challenge.kind === 'otp') { this.credentials.clearTask(taskId); dropAnswer(); }
      const allowPasswordCache = !!cachingEnabled && attempts === 1 && challenge.kind !== 'otp' && !!prompt && !!promptBinding;
      binding.prompt = promptBinding;
      if (!promptBinding || !prompt) this.credentials.clearTask(taskId);
      const cached = allowPasswordCache ? this.credentials.read(binding) : undefined;
      if (cached !== undefined) {
        if (current() && this.terminal.answerAuthentication(terminalId, operation.id, challenge.id, cached)) {
          waiting = undefined;
          this.onCredentialReuse?.(taskId, hostId, operation.id);
          return;
        }
        this.credentials.forget(binding); cancel(); return;
      }
      const sink: InteractionSink = {
        isWaiting: (request) => active && current() && waiting === challenge.id
          && request.operationId === operation.id && request.connectionGeneration === connectionGeneration,
        deliver: async (request, answer) => {
          if (!sink.isWaiting(request)) return false;
          const value = privateAnswerValue(answer);
          const sent = this.terminal.answerAuthentication(terminalId, operation.id, challenge.id, value);
          waiting = undefined;
          if (!sent) cancel();
          else {
            dropAnswer();
            if (value !== null && allowPasswordCache && typeof answer === 'object' && answer !== null
              && answer.action === 'submit' && answer.cacheAsPassword === true) lastAnswer = Buffer.from(value);
          }
          return sent;
        }
      };
      const goal = operation.scope.goal.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 160);
      const details: Omit<InputRequest, 'id' | 'expiresAt'> = {
        taskId, operationId: operation.id, hostId, terminalId, terminalGeneration, connectionGeneration,
        kind: challenge.kind === 'otp' ? 'otp' : 'secret', recipient: 'sudo',
        prompt: `sudo 认证挑战（本进程第 ${processAttempts}/${maxAttempts} 次请求）`, allowPasswordCache,
        reason: `为了完成“${goal}”，本次已审核的 sudo 进程请求认证。服务器提示：${prompt.slice(0, 300) || '未提供提示'}。`
          + '再次请求可能是多因素认证，不自动等于密码错误。回答仅交给当前认证进程，不进入命令输入、AI 上下文或日志。'
          + (allowPasswordCache ? '只有勾选“这是可复用密码”且本次仅有一次认证请求并成功，才会在任务内存中缓存最多 5 分钟；提示变化、多次请求、失败、暂停或断线即清除。' : '本次回答不会缓存。')
      };
      void this.interactions.request(details, sink).then((status) => {
        if (status !== 'submitted' && active) cancel(status === 'expired' ? current() ? 'timeout' : 'transport-unavailable' : 'cancelled');
      }).catch(() => cancel());
    });
    let output = '';
    let confirmed = false;
    const unsubscribeOutput = this.terminal.subscribeData(terminalId, (data) => {
      output = (output + data).slice(-8192);
      if (!active || !plan.aptInstall || confirmed || !current()
        || !/Do you want to continue\?\s*\[Y\/n\]\s*$/u.test(output)) return;
      if (!aptHasNoRemovals(output)) {
        this.terminal.confirmInput(terminalId, operation.id, 'n\n'); cancel(); return;
      }
      confirmed = this.terminal.confirmInput(terminalId, operation.id, 'y\n');
      if (confirmed) this.onAutoConfirmation?.(taskId, hostId);
    });
    const leaseCheck = setInterval(() => { if (!current()) cancel('transport-unavailable'); }, 100);
    const onAbort = () => cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const observed = await this.terminal.execute(operation, fingerprint, signal, options);
      const result = describeSudoOutcome(analysis, interrupted ? { ...observed, privilege: interrupted, authenticationAttempts: attempts, requiresUserAction: true } : observed, attempts);
      if (result.privilege && result.privilege.recovery !== 'private-input') result.requiresUserAction = true;
      if (result.authentication === 'succeeded' && attempts === 1 && lastAnswer && current()) this.credentials.remember(binding, lastAnswer);
      if (result.authentication === 'failed' || result.status !== 'succeeded') this.credentials.clearTask(taskId);
      if (result.authentication === 'failed') this.terminal.suspend(terminalId);
      return result;
    } catch (error) {
      this.credentials.clearTask(taskId);
      throw error;
    } finally {
      active = false; dropAnswer();
      if (waiting && this.terminal.hostOf(terminalId) === hostId) this.terminal.answerAuthentication(terminalId, operation.id, waiting, null);
      clearInterval(leaseCheck);
      signal?.removeEventListener('abort', onAbort);
      unsubscribeAuth(); unsubscribeOutput();
      this.interactions.cancelForTerminal(terminalId);
    }
  }
}
