import { ShellMarkerParser, type ShellCommandEvent } from './shell-integration.js';
import { StringDecoder } from 'node:string_decoder';
import { CommandNotStartedError, redactOutput, type AgentExecutionPort, type HumanTerminalPort, type AuthenticationChallenge, type NativeBinding, type OperationResult, type RawTerminal, type RawTerminalExecutionContext } from '@cloudhelm/core';
import type { ClientChannel } from 'ssh2';
import type { SshTransport } from './ssh-transport.js';
export type CommandTransport = Pick<SshTransport, 'connectionGeneration' | 'prepareCommandProgram' | 'removeCommandProgram' | 'openPipe' | 'shell'> & Partial<Pick<SshTransport, 'integratedShell'>>;

/** Commands are process arguments; PTY input and sudo credentials have distinct channels. */
export class SshCommandTerminal implements RawTerminal {
  readonly agent: AgentExecutionPort = {
    execute: (...args) => this.execute(...args), confirmInput: (...args) => this.confirmInput(...args),
    interrupt: (id) => this.interrupt(id), respondToTerminalQuery: (...args) => this.respondToTerminalQuery(...args),
    answerAuthentication: (...args) => this.answerAuthentication(...args), resize: (...args) => this.resizeAgent(...args),
    onAuthentication: (listener) => this.onAuthentication(listener), onExit: (listener) => this.onExit(listener),
    onExecutionFailure: (listener) => this.onExecutionFailure(listener)
  };
  readonly human: HumanTerminalPort = {
    open: async () => { await this.openHuman(); }, write: (data) => this.writeHuman(data), resize: (...args) => this.resizeHuman(...args),
    respondToTerminalQuery: (data) => {
      if (!this.humanChannel || this.closed || !this.isTerminalResponse(data)) return false;
      this.humanChannel.write(data); return true;
    }
  };
  private program?: string;
  private active?: ClientChannel;
  private humanChannel?: ClientChannel;
  private humanOpening?: Promise<ClientChannel>;
  private humanOwned = false;
  private closed = false;
  private busy = false;
  private precedingSteps = false;
  private cols = 100;
  private rows = 30;
  private prompt = '';
  private syntheticPromptShown = false;
  private lineStart = true;
  private challenges = new Set<string>();
  private binding?: NativeBinding;
  private command = (_event: ShellCommandEvent) => {};
  onCommand(listener: (event: ShellCommandEvent) => void): void { this.command = listener; }
  private data = (_text: string) => {};
  private display = (_text: string) => {};
  private failure = (_failure: Pick<OperationResult, 'failureKind' | 'effects' | 'privilege'>) => {};
  private exited = (_code: number | undefined) => {};
  private closedListener = () => {};
  private authentication = (_challenge: AuthenticationChallenge) => {};
  private readonly generation: number;

  constructor(private readonly ssh: CommandTransport, private readonly hostId: string) {
    this.generation = ssh.connectionGeneration(hostId);
  }

  onData(listener: (text: string) => void): void { this.data = listener; }
  onDisplay(listener: (text: string) => void): void { this.display = listener; }
  onExecutionFailure(listener: typeof this.failure): void { this.failure = listener; }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  onClose(listener: () => void): void { this.closedListener = listener; }
  onAuthentication(listener: (challenge: AuthenticationChallenge) => void): void { this.authentication = listener; }

  async execute(command: string, cwd: string, isAuthorized: () => boolean, context?: RawTerminalExecutionContext): Promise<void> {
    const current = () => {
      if (this.closed || this.generation !== this.ssh.connectionGeneration(this.hostId) || !isAuthorized()) {
        throw new Error('Command authorization expired');
      }
    };
    current();
    if (this.busy || this.humanOwned || this.humanChannel || this.humanOpening) throw new Error('The command terminal is busy or human-owned');
    // The reviewed plan is authoritative. Never reinterpret shell source into argv here.
    if (!context?.plan) throw new CommandNotStartedError('命令缺少审核绑定的执行计划；未发送业务命令。');
    const steps = context.plan.steps;
    if (!steps.length) throw new CommandNotStartedError('执行计划为空；未发送业务命令。');
    // Reserve the operation before the first await so a second caller cannot
    // replace its binding while runtime preparation is still in flight.
    this.busy = true;
    this.binding = { version: 1, operationId: context.operationId, sessionId: context.sessionId, generation: context.generation };
    try {
      current();
      this.program = await this.ssh.prepareCommandProgram(this.hostId, '', current, this.binding);
    } catch (error) {
      this.busy = false;
      // Keep the concrete transport cause visible; the generic checklist alone hides what to fix.
      const cause = redactOutput(error instanceof Error ? error.message : String(error)).trim().slice(0, 300);
      throw new CommandNotStartedError(`命令未发送：${cause || '已授权的远端执行组件不可用'}。请先完成运行组件准备后再继续。`);
    }
    try { current(); } catch { this.busy = false; throw new CommandNotStartedError('命令授权在发送前已失效；未发送业务命令。'); }
    this.lineStart = true;
    const finish = (code?: number) => {
      this.busy = false;
      // The exit report can synchronously hand the terminal back to the human owner;
      // decide on the synthetic prompt only after that handover is known.
      try { this.exited(code); }
      finally {
        if (code !== undefined && !this.humanOwned && !this.closed) {
          this.display(`${this.lineStart ? '' : '\r\n'}${this.prompt}`);
          this.syntheticPromptShown = true;
        }
      }
    };
    const next = async (index: number, code: number): Promise<void> => {
      while (index < steps.length) {
        const condition = steps[index]!.condition;
        if ((condition === 'success' && code !== 0) || (condition === 'failure' && code === 0)) index++;
        else break;
      }
      if (index >= steps.length) { finish(code); return; }
      const step = steps[index]!;
      this.precedingSteps = index > 0;
      await this.startProcess(step.argv, cwd,
        step.authentication === 'sudo', index === 0 ? command : undefined, index, current, (exitCode) => {
          if (exitCode === undefined) { finish(); return; }
          void next(index + 1, exitCode).catch(() => finish());
        });
    };
    try { await next(0, 0); }
    catch (error) { this.busy = false; throw error; }
  }

  private async startProcess(argv: string[], cwd: string, sudo: boolean, command: string | undefined,
    stepIndex: number, current: () => void, onComplete: (code?: number) => void): Promise<void> {
    // Installation was separately authorized. Only the fixed deployed executable is invoked.
    const notStarted = (error: unknown): Error => stepIndex > 0 ? error instanceof Error ? error : new Error('Later command preparation failed')
      : new CommandNotStartedError(`命令未发送：${redactOutput(error instanceof Error ? error.message : String(error)).slice(0, 300)}。`);
    let channel: ClientChannel | undefined;
    try {
      current();
      channel = await this.ssh.openPipe(this.hostId, `'${this.program!.replace(/'/gu, `'"'"'`)}' --serve`);
      current();
    } catch (error) { channel?.end(); channel?.close(); throw notStarted(error); }
    this.active = channel;
    const decoder = new StringDecoder('utf8');
    const outputDecoder = new StringDecoder('utf8');
    const binding = this.binding!;
    let buffer = '';
    let completed = false;
    let dispatched = false;
    let started = false;
    let promptSeen = false;
    let displaySeen = false;
    const issuedChallenges = new Set<string>();
    let awaitingAuthClose: string | undefined;
    const complete = (code?: number) => {
      if (completed) return;
      completed = true;
      this.active = undefined;
      const tail = outputDecoder.end(); if (tail) this.data(tail);
      for (const id of this.challenges) this.authentication({ id });
      this.challenges.clear();
      channel!.end();
      onComplete(code);
    };
    channel.on('data', (data: Buffer) => {
      if (completed) return;
      buffer += decoder.write(data);
      if (!dispatched || Buffer.byteLength(buffer) >= 2 * 1024 * 1024) { complete(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.version !== binding.version || event.operationId !== binding.operationId || event.sessionId !== binding.sessionId
            || event.generation !== binding.generation) { complete(); return; }
          if (event.type === 'started') {
            if (started || !Number.isSafeInteger(event.pid) || (event.pid as number) < 1
              || !Number.isSafeInteger(event.supervisorUid) || (event.supervisorUid as number) < 0
              || !Number.isSafeInteger(event.supervisorEuid) || (event.supervisorEuid as number) < 0) { complete(); return; }
            started = true; continue;
          }
          if (!started && event.type !== 'launch-error' || started && event.type === 'launch-error') { complete(); return; }
          if (event.type === 'data' && typeof event.dataBase64 === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(event.dataBase64)) {
            const bytes = Buffer.from(event.dataBase64, 'base64');
            if (bytes.toString('base64') !== event.dataBase64) { complete(); return; }
            const text = outputDecoder.write(bytes);
            this.data(text);
            if (text) { this.lineStart = text.endsWith('\n'); this.syntheticPromptShown = false; }
          } else if (event.type === 'display' && typeof event.data === 'string') {
            if (displaySeen) { complete(); return; } displaySeen = true;
            this.display(event.data);
            this.syntheticPromptShown = false;
          }
          else if (event.type === 'prompt' && typeof event.data === 'string') {
            if (promptSeen) { complete(); return; } promptSeen = true; this.prompt = event.data;
          }
          else if (event.type === 'launch-error' && ['permission-denied', 'unsupported'].includes(String(event.kind))) {
            this.failure({ failureKind: event.kind as 'permission-denied' | 'unsupported', effects: this.precedingSteps ? 'possible' : 'none',
              ...(sudo && event.code === 'sudo-unavailable' ? { privilege: { method: 'sudo', stage: 'preparation', code: 'sudo-unavailable',
                source: 'transport', businessCommand: this.precedingSteps ? 'unknown' : 'not-started', recovery: this.precedingSteps ? 'verify' : 'confirm-alternative' } as const } : {}) });
            this.data(event.kind === 'unsupported' ? '命令未启动：所需工具或工作目录不存在。请确认工具已安装、路径正确后继续。' : '命令未启动：当前身份无权访问工具或工作目录。请核验权限后提交新的审核操作。'); complete(127); return;
          }
          else if (event.type === 'exit' && Number.isInteger(event.code) && (event.code as number) >= 0 && (event.code as number) <= 255) { complete(event.code as number); return; }
          else if (event.type === 'auth' && typeof event.id === 'string' && /^[a-f0-9]{32}$/u.test(event.id)) {
            if (!sudo || awaitingAuthClose || issuedChallenges.has(event.id) || issuedChallenges.size >= 3) { complete(); return; }
            if (typeof event.prompt === 'string' && Buffer.byteLength(event.prompt) > 4096) { complete(); return; }
            if (typeof event.promptSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(event.promptSha256)) { complete(); return; }
            issuedChallenges.add(event.id); awaitingAuthClose = event.id;
            this.challenges.add(event.id);
            this.authentication({ id: event.id, prompt: typeof event.prompt === 'string' ? event.prompt : 'sudo 身份验证',
              ...(typeof event.promptSha256 === 'string' ? { promptSha256: event.promptSha256 } : {}),
              mechanism: 'sudo', kind: 'unknown', processId: `${binding.operationId}:${stepIndex}` });
          } else if (event.type === 'auth-close' && typeof event.id === 'string') {
            if (awaitingAuthClose !== event.id) { complete(); return; } awaitingAuthClose = undefined;
            this.challenges.delete(event.id); this.authentication({ id: event.id });
          } else { this.data('命令执行通道异常，请核验远端结果后再继续。'); complete(); return; }
        } catch { complete(); return; }
      }
    });
    channel.stderr.on('data', () => { this.data('无法启动已授权的命令执行组件；请核验组件和远端结果。'); complete(); });
    channel.on('error', () => complete());
    channel.on('close', () => complete());
    try { current(); if (completed) throw new Error('Command channel closed before launch'); }
    catch (error) { completed = true; this.active = undefined; channel.end(); channel.close(); throw notStarted(error); }
    dispatched = true;
    try { channel.write(`${JSON.stringify({ ...binding, type: 'launch', payload: { argv, cwd, sudo, command, cols: this.cols, rows: this.rows } })}\n`); }
    catch { complete(); }
  }

  answerAuthentication(id: string, answer: string | null): boolean {
    if (!this.active || !this.challenges.has(id) || (answer !== null && (answer.length > 4095 || /[\r\n\u0000]/u.test(answer)))) return false;
    this.challenges.delete(id);
    this.active.write(`${JSON.stringify({ ...this.binding, type: 'answer', id, answer })}\n`);
    return true;
  }

  confirmInput(operationId: string, answer: 'y\n' | 'n\n'): boolean {
    if (this.humanOwned || !['y\n', 'n\n'].includes(answer)) return false;
    return this.processInput(operationId, answer);
  }

  interrupt(operationId: string): boolean { return this.processInput(operationId, '\u0003'); }

  respondToTerminalQuery(operationId: string, data: string): boolean {
    return this.isTerminalResponse(data) && this.processInput(operationId, data);
  }

  private processInput(operationId: string, data: string): boolean {
    if (!this.active || !this.busy || this.closed || this.binding?.operationId !== operationId) return false;
    this.active.write(`${JSON.stringify({ ...this.binding, type: 'input', data: Buffer.from(data).toString('base64') })}\n`);
    return true;
  }

  private isTerminalResponse(data: string): boolean { return /^(?:\u001b\[(?:\?|>)[\d;]*c|\u001b\[\d+;\d+R)$/u.test(data); }

  writeHuman(data: string): void {
    if (!this.humanOwned || this.closed || this.active || this.busy) throw new Error('Human input cannot enter an Agent process');
    if (this.humanChannel) this.humanChannel.write(data);
    else {
      void this.openHuman().then((channel) => channel.write(data)).catch(() => this.close());
    }
  }

  private openHuman(): Promise<ClientChannel> {
    if (!this.humanOwned || this.closed || this.active || this.busy) return Promise.reject(new Error('Human shell capability is not active'));
    // Only explicit human takeover opens an interactive shell; the Agent never receives this route.
    this.humanOpening ??= (this.ssh.integratedShell ? this.ssh.integratedShell(this.hostId, this.cols, this.rows)
      : this.ssh.shell(this.hostId, this.cols, this.rows).then((channel) => ({ channel, nonce: '' }))).then(({ channel, nonce }) => {
      this.command({ phase: 'unavailable' });
      if (this.closed) { channel.end(); throw new Error('Terminal closed'); }
      this.humanChannel = channel;
      channel.setWindow(this.rows, this.cols, 0, 0);
      // The banner of a fresh login shell can look like a reconnect; state the handover
      // first and erase the synthetic prompt left on screen by the finished command.
      this.display(`${this.syntheticPromptShown ? '\r\x1b[2K' : this.lineStart ? '' : '\r\n'}—— 终端已交还人工输入 ——\r\n`);
      this.syntheticPromptShown = false;
      this.lineStart = true;
      const decoder = new StringDecoder('utf8');
      const parser = new ShellMarkerParser(nonce, (text) => this.data(text), (event) => this.command(event));
      channel.on('data', (chunk: Buffer) => { this.syntheticPromptShown = false; parser.push(decoder.write(chunk)); });
      channel.on('close', () => this.close());
      channel.on('error', () => this.close());
      return channel;
    });
    return this.humanOpening;
  }

  takeOver(): void {
    this.humanOwned = true;
    // Ownership release does not create a shell or run startup files. First human input does.
  }

  resizeAgent(cols: number, rows: number): void {
    this.cols = cols; this.rows = rows;
    if (this.active) this.active.write(`${JSON.stringify({ ...this.binding, type: 'resize', cols, rows })}\n`);
  }

  resizeHuman(cols: number, rows: number): void {
    this.cols = cols; this.rows = rows;
    this.humanChannel?.setWindow(rows, cols, 0, 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.active?.end(); this.active?.close(); this.humanChannel?.end();
    this.closedListener();
    // Runtime installation and cleanup belong to the audited runtime owner.
  }
}
