import { CommandNotStartedError } from '@cloudhelm/core';
import { randomUUID } from 'node:crypto';
import type { AuthenticationChallenge, ExecutionOptions, OperationExecutor, OperationResult, ProposedOperation, RawTerminal, TerminalLease } from '@cloudhelm/core';
import { operationFingerprint } from '@cloudhelm/core';
import { OperationOutputCapture } from './operation-output-capture.js';

type Owner = 'agent' | 'human' | 'suspended' | 'closed';

interface PendingCommand {
  capture: OperationOutputCapture;
  failure?: Pick<OperationResult, 'failureKind' | 'effects' | 'privilege'>;
  settle(result: OperationResult): void;
  remoteCompletion: Promise<'exited' | 'unknown'>;
  completeRemote(state: 'exited' | 'unknown'): void;
  reported: boolean;
  operationId: string;
  stopRequested?: boolean;
}

interface TerminalRecord {
  id: string;
  hostId: string;
  taskId?: string;
  generation: number;
  home: string;
  owner: Owner;
  channel: RawTerminal;
  pending?: PendingCommand;
  commandRunning?: boolean;
}

export interface TerminalEvents {
  command?(terminalId: string, generation: number, event: { phase: 'start' | 'end' | 'unavailable'; command?: string; exitCode?: number }): void;
  data(terminalId: string, data: string, operationId?: string): void;
  completed?(result: OperationResult): void;
  state(terminalId: string, owner: Owner): void;
}

/** Sole writer to SSH PTYs; review grants never bypass the current ownership generation. */
export class TerminalManager implements TerminalLease, OperationExecutor {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly listeners = new Map<string, Set<(data: string) => void>>();

  constructor(private readonly events: TerminalEvents) {}

  open(hostId: string, channel: RawTerminal, taskId?: string, home = '/'): string {
    const terminal: TerminalRecord = {
      id: randomUUID(), hostId, taskId, home, generation: 1, owner: taskId ? 'agent' : 'human', channel
    };
    this.terminals.set(terminal.id, terminal);
    channel.onCommand?.((event) => { terminal.commandRunning = event.phase === 'start'; this.events.command?.(terminal.id, terminal.generation, event); });
    channel.onData((data) => this.receive(terminal, data));
    channel.onDisplay?.((data) => this.events.data(terminal.id, data));
    channel.onClose(() => this.closeRecord(terminal));
    channel.agent?.onExecutionFailure?.((failure) => { if (terminal.pending) terminal.pending.failure = failure; });
    channel.agent?.onExit?.((code) => this.complete(terminal, code));
    this.events.state(terminal.id, terminal.owner);
    return terminal.id;
  }

  currentGeneration(id: string): number { return this.terminals.get(id)?.generation ?? -1; }
  isAgentOwner(id: string): boolean { return this.terminals.get(id)?.owner === 'agent'; }
  workingDirectory(id: string): string { return this.require(id).home; }
  hostOf(id: string): string | undefined { return this.terminals.get(id)?.hostId; }
  taskOf(id: string): string | undefined { return this.terminals.get(id)?.taskId; }
  subscribeData(id: string, listener: (data: string) => void): () => void {
    this.require(id);
    const set = this.listeners.get(id) ?? new Set<(data: string) => void>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  subscribeAuthentication(id: string, listener: (challenge: AuthenticationChallenge) => void): () => void {
    const channel = this.require(id).channel;
    channel.agent?.onAuthentication?.(listener);
    return () => channel.agent?.onAuthentication?.(() => {});
  }

  answerAuthentication(id: string, operationId: string, challengeId: string, answer: string | null): boolean {
    const terminal = this.require(id);
    if (terminal.pending?.operationId !== operationId || (answer !== null && terminal.owner !== 'agent')) return false;
    return terminal.channel.agent?.answerAuthentication?.(challengeId, answer) ?? false;
  }

  confirmInput(id: string, operationId: string, answer: 'y\n' | 'n\n'): boolean {
    const terminal = this.require(id);
    if (terminal.pending?.operationId !== operationId || terminal.owner !== 'agent') return false;
    return terminal.channel.agent?.confirmInput?.(operationId, answer) ?? false;
  }

  hasPending(id: string): boolean { return !!this.terminals.get(id)?.pending; }
  pendingOperations(taskId: string): string[] {
    return [...this.terminals.values()].flatMap((terminal) => terminal.taskId === taskId && terminal.pending ? [terminal.pending.operationId] : []);
  }
  releaseIdle(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal && !terminal.pending) this.takeOver(id);
  }

  input(id: string, data: string, humanIntent: boolean): void {
    const terminal = this.require(id);
    if (!humanIntent) {
      if (!this.isProtocolResponse(data)) return;
      if (terminal.pending) terminal.channel.agent?.respondToTerminalQuery?.(terminal.pending.operationId, data);
      else if (terminal.owner === 'human') terminal.channel.human?.respondToTerminalQuery?.(data);
      return;
    }
    if (terminal.owner !== 'human' || terminal.pending) throw new Error('终端暂不可输入，请先停止 AI 并等待命令退出');
    if (!terminal.channel.human) throw new Error('此执行会话没有人工输入端口，请打开独立 SSH 终端');
    if (!terminal.commandRunning && /[\r\n]/u.test(data)) this.events.command?.(terminal.id, terminal.generation, { phase: 'unavailable' });
    terminal.channel.human.write(data);
  }

  takeOver(id: string): void {
    const terminal = this.require(id);
    if (terminal.owner !== 'agent' && terminal.owner !== 'suspended') return;
    terminal.generation++;
    terminal.owner = 'human';
    terminal.channel.takeOver?.();
    if (terminal.pending && !terminal.pending.reported) {
      const pending = terminal.pending;
      pending.reported = true;
      pending.settle({ operationId: pending.operationId, status: 'handed-over',
        ...pending.capture.snapshot(), logRef: terminal.id, remoteCompletion: pending.remoteCompletion });
    }
    this.events.state(id, 'human');
  }

  suspend(id: string): void {
    const terminal = this.require(id);
    if (terminal.owner !== 'agent') return;
    terminal.generation++;
    terminal.owner = 'suspended';
    if (terminal.pending && !terminal.pending.reported) {
      const pending = terminal.pending;
      pending.reported = true;
      pending.settle({ operationId: pending.operationId, status: 'unknown',
        ...pending.capture.snapshot(), logRef: terminal.id, remoteCompletion: pending.remoteCompletion });
    }
    this.events.state(id, 'suspended');
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.require(id);
    if (terminal.pending || terminal.owner === 'agent' || terminal.owner === 'suspended') terminal.channel.agent?.resize?.(cols, rows);
    else terminal.channel.human?.resize(cols, rows);
  }

  close(id: string): void {
    const terminal = this.require(id);
    this.suspend(id);
    try { terminal.channel.close(); } finally { this.closeRecord(terminal); }
  }

  stopCommand(id: string): void {
    const terminal = this.require(id);
    if (!terminal.pending || terminal.pending.stopRequested) return;
    terminal.pending.stopRequested = true;
    // Only invoked by an explicit user stop action, never to recover a shell.
    try {
      if (!terminal.channel.agent?.interrupt?.(terminal.pending.operationId)) throw new Error('此执行会话无法确认停止信号送达，请核验远端状态');
    } catch (error) { terminal.pending.stopRequested = false; throw error; } finally { this.suspend(id); }
  }

  stopTaskCommands(taskId: string): void {
    const errors: unknown[] = [];
    for (const terminal of this.terminals.values()) if (terminal.taskId === taskId && terminal.pending) {
      try { this.stopCommand(terminal.id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new Error('部分命令的停止信号未送达，请核验远端状态');
  }

  closeHost(hostId: string): void {
    const errors: unknown[] = [];
    for (const terminal of [...this.terminals.values()]) if (terminal.hostId === hostId) {
      try { this.close(terminal.id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new Error('部分主机终端关闭失败，请核验远端状态');
  }

  /** A task may own older suspended/human generations as well as its current terminal. */
  closeTask(taskId: string): void {
    const errors: unknown[] = [];
    for (const terminal of [...this.terminals.values()]) if (terminal.taskId === taskId) {
      try { this.close(terminal.id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new Error('部分任务终端关闭失败，请核验远端状态');
  }

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    const terminal = this.require(operation.scope.terminalId);
    if (operation.kind !== 'command') throw new Error('Structured file operations require a separate audited executor');
    if (terminal.taskId !== operation.scope.taskId || terminal.hostId !== operation.scope.hostId
      || terminal.owner !== 'agent' || terminal.generation !== operation.scope.terminalGeneration
      || operationFingerprint(operation) !== fingerprint || signal?.aborted || terminal.pending || options?.isAuthorized?.() === false) {
      throw new Error('Agent terminal authorization expired');
    }
    if (!terminal.channel.agent) throw new Error('This terminal does not expose an Agent execution capability');
    return new Promise<OperationResult>((resolve) => {
      let completeRemote!: (state: 'exited' | 'unknown') => void;
      const remoteCompletion = new Promise<'exited' | 'unknown'>((done) => { completeRemote = done; });
      const pending: PendingCommand = { capture: new OperationOutputCapture(), operationId: operation.id, settle: resolve,
        remoteCompletion, completeRemote, reported: false };
      terminal.pending = pending;
      this.events.command?.(terminal.id, terminal.generation, { phase: 'start', command: operation.command });
      signal?.addEventListener('abort', () => {
        if (terminal.pending !== pending) return;
        terminal.generation++;
        terminal.owner = 'suspended';
        this.events.state(terminal.id, 'suspended');
        if (!pending.reported) {
          pending.reported = true;
          resolve({ operationId: operation.id, status: 'unknown', ...pending.capture.snapshot(),
            logRef: terminal.id, remoteCompletion });
        }
      }, { once: true });
      const current = () => !signal?.aborted && terminal.owner === 'agent'
        && terminal.generation === operation.scope.terminalGeneration && options?.isAuthorized?.() !== false;
      if (!terminal.channel.onDisplay) this.events.data(terminal.id, `$ ${operation.command}\r\n`);
      void terminal.channel.agent!.execute(operation.command, operation.scope.cwd, current, {
        operationId: operation.id, sessionId: operation.scope.sessionId ?? terminal.id,
        generation: operation.scope.terminalGeneration, plan: operation.executionPlan
      }).catch((error: unknown) => {
        this.receive(terminal, error instanceof Error ? error.message : 'Command transport failed');
        if (error instanceof CommandNotStartedError && terminal.pending === pending) {
          pending.failure = { failureKind: 'unsupported', effects: 'none' };
          this.complete(terminal, 127);
        } else this.complete(terminal, undefined);
      });
    });
  }

  private receive(terminal: TerminalRecord, data: string): void {
    const pending = terminal.pending;
    this.events.data(terminal.id, data, pending?.operationId);
    pending?.capture.push(data);
    for (const listener of this.listeners.get(terminal.id) ?? []) listener(data);
  }

  private complete(terminal: TerminalRecord, exitCode: number | undefined): void {
    const pending = terminal.pending;
    if (!pending) return;
    terminal.pending = undefined;
    this.events.command?.(terminal.id, terminal.generation, { phase: 'end', exitCode });
    pending.capture.finish();
    pending.completeRemote(exitCode === undefined ? 'unknown' : 'exited');
    const result: OperationResult = { operationId: pending.operationId,
      status: exitCode === undefined ? 'unknown' : exitCode === 0 ? 'succeeded' : 'failed',
      failureKind: exitCode === undefined ? 'unknown' : exitCode && /permission denied|operation not permitted/iu.test(pending.capture.text) ? 'permission-denied' : undefined,
      effects: exitCode === 0 ? undefined : 'possible', ...pending.failure,
      exitCode, ...pending.capture.snapshot(), logRef: terminal.id };
    this.events.completed?.(result);
    if (!pending.reported) pending.settle(result);
  }

  private closeRecord(terminal: TerminalRecord): void {
    if (terminal.owner === 'closed') return;
    terminal.owner = 'closed';
    terminal.generation++;
    // Publish loss of observability even if Stop already settled the tool call.
    this.complete(terminal, undefined);
    this.events.state(terminal.id, 'closed');
    this.listeners.delete(terminal.id);
    this.terminals.delete(terminal.id);
  }

  private isProtocolResponse(data: string): boolean {
    return /^(?:\u001b\[(?:\?|>)[\d;]*c|\u001b\[\d+;\d+R)$/u.test(data);
  }

  private require(id: string): TerminalRecord {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error('Terminal not found');
    return terminal;
  }
}
