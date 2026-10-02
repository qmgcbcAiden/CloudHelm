import { randomUUID } from 'node:crypto';
import type { ExecutionOptions, OperationExecutor, OperationResult, ProposedOperation, RawTerminal, TerminalLease } from '@cloudhelm/core';
import { commandEnvelope } from './command-envelope.js';
import { operationFingerprint } from '@cloudhelm/core';

type Owner = 'agent' | 'human' | 'suspended' | 'closed';

interface PendingCommand {
  marker: string;
  output: string;
  settle(result: OperationResult): void;
  remoteCompletion: Promise<'exited' | 'unknown'>;
  completeRemote(state: 'exited' | 'unknown'): void;
  reported: boolean;
  operationId: string;
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
}

export interface TerminalEvents {
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
    channel.onData((data) => this.receive(terminal, data));
    channel.onClose(() => this.closeRecord(terminal));
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

  input(id: string, data: string, humanIntent: boolean): void {
    const terminal = this.require(id);
    if (humanIntent && (terminal.owner === 'agent' || terminal.owner === 'suspended')) this.takeOver(id);
    if (terminal.owner === 'human') terminal.channel.write(data);
    else if (!humanIntent && this.isProtocolResponse(data)) terminal.channel.write(data);
  }

  takeOver(id: string): void {
    const terminal = this.require(id);
    if (terminal.owner !== 'agent' && terminal.owner !== 'suspended') return;
    terminal.generation++;
    terminal.owner = 'human';
    if (terminal.pending && !terminal.pending.reported) {
      const pending = terminal.pending;
      pending.reported = true;
      pending.settle({ operationId: pending.operationId, status: 'handed-over',
        stdoutTail: pending.output.slice(-16_384), logRef: terminal.id, remoteCompletion: pending.remoteCompletion });
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
        stdoutTail: pending.output.slice(-16_384), logRef: terminal.id, remoteCompletion: pending.remoteCompletion });
    }
    this.events.state(id, 'suspended');
  }

  handBack(id: string): void {
    const terminal = this.require(id);
    if (terminal.owner !== 'human' || !terminal.taskId) throw new Error('This terminal is not a human-controlled Agent session');
    // The existing PTY stays with the user; the Agent resumes in a new session.
    terminal.generation++;
    this.events.state(id, 'human');
  }

  resize(id: string, cols: number, rows: number): void {
    this.require(id).channel.resize(cols, rows);
  }

  close(id: string): void {
    const terminal = this.require(id);
    this.suspend(id);
    terminal.channel.close();
  }

  stopCommand(id: string): void {
    const terminal = this.require(id);
    if (!terminal.pending) return;
    // Only invoked by an explicit user stop action, never to recover a shell.
    terminal.channel.write('\u0003');
    this.suspend(id);
  }

  stopTaskCommands(taskId: string): void {
    for (const terminal of this.terminals.values()) if (terminal.taskId === taskId && terminal.pending) this.stopCommand(terminal.id);
  }

  closeHost(hostId: string): void {
    for (const terminal of this.terminals.values()) if (terminal.hostId === hostId) this.close(terminal.id);
  }

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    const terminal = this.require(operation.scope.terminalId);
    if (operation.kind !== 'command') throw new Error('Structured file operations require a separate audited executor');
    if (terminal.taskId !== operation.scope.taskId || terminal.hostId !== operation.scope.hostId
      || terminal.owner !== 'agent' || terminal.generation !== operation.scope.terminalGeneration
      || operationFingerprint(operation) !== fingerprint || signal?.aborted || terminal.pending || options?.isAuthorized?.() === false) {
      throw new Error('Agent terminal authorization expired');
    }
    const marker = `__CLOUDHELM_DONE_${randomUUID().replace(/-/gu, '')}__`;
    return new Promise<OperationResult>((resolve) => {
      let completeRemote!: (state: 'exited' | 'unknown') => void;
      const remoteCompletion = new Promise<'exited' | 'unknown'>((done) => { completeRemote = done; });
      const pending: PendingCommand = { marker, output: '', operationId: operation.id, settle: resolve,
        remoteCompletion, completeRemote, reported: false };
      terminal.pending = pending;
      signal?.addEventListener('abort', () => {
        if (terminal.pending !== pending) return;
        terminal.generation++;
        terminal.owner = 'suspended';
        this.events.state(terminal.id, 'suspended');
        if (!pending.reported) {
          pending.reported = true;
          resolve({ operationId: operation.id, status: 'unknown', stdoutTail: pending.output.slice(-16_384),
            logRef: terminal.id, remoteCompletion });
        }
      }, { once: true });
      terminal.channel.write(commandEnvelope(operation.command, operation.scope, terminal.home, marker));
    });
  }

  private receive(terminal: TerminalRecord, data: string): void {
    this.events.data(terminal.id, data, terminal.pending?.operationId);
    for (const listener of this.listeners.get(terminal.id) ?? []) listener(data);
    const pending = terminal.pending;
    if (!pending) return;
    pending.output = (pending.output + data).slice(-65_536);
    const match = new RegExp(`${pending.marker}:(\\d+)`).exec(pending.output);
    if (!match) return;
    terminal.pending = undefined;
    const exitCode = Number(match[1]);
    pending.completeRemote('exited');
    this.events.completed?.({ operationId: pending.operationId, status: exitCode === 0 ? 'succeeded' : 'failed', exitCode, stdoutTail: pending.output.slice(-16_384), logRef: terminal.id });
    if (!pending.reported) pending.settle({ operationId: pending.operationId,
      status: exitCode === 0 ? 'succeeded' : 'failed', exitCode, stdoutTail: pending.output.slice(-16_384), logRef: terminal.id });
  }

  private closeRecord(terminal: TerminalRecord): void {
    terminal.owner = 'closed';
    terminal.generation++;
    if (terminal.pending) {
      const pending = terminal.pending;
      pending.completeRemote('unknown');
      if (!pending.reported) pending.settle({ operationId: pending.operationId,
        status: 'unknown', stdoutTail: pending.output.slice(-16_384),
        logRef: terminal.id, remoteCompletion: pending.remoteCompletion });
    }
    terminal.pending = undefined;
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
