import { randomUUID } from 'node:crypto';
import type { InputRequest, TerminalLease } from '@cloudhelm/core';

export interface InteractionSink {
  deliver(request: InputRequest, answer: string): Promise<boolean>;
  isWaiting(request: InputRequest): boolean;
}

export interface InteractionPublisher {
  opened(request: InputRequest): void;
  closed(requestId: string): void;
}

interface PendingInput {
  request: InputRequest;
  sink: InteractionSink;
  resolve: (result: 'submitted' | 'canceled' | 'expired') => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class InteractionCoordinator {
  private readonly pending = new Map<string, PendingInput>();

  constructor(private readonly lease: TerminalLease, private readonly publisher: InteractionPublisher) {}

  request(details: Omit<InputRequest, 'id' | 'expiresAt'>, sink: InteractionSink, timeoutMs = 120_000): Promise<'submitted' | 'canceled' | 'expired'> {
    const request: InputRequest = { ...details, id: randomUUID(), expiresAt: Date.now() + timeoutMs };
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.close(request.id, 'expired'), timeoutMs);
      this.pending.set(request.id, { request, sink, resolve, timeout });
      this.publisher.opened(request);
    });
  }

  async answer(requestId: string, answer: string): Promise<boolean> {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    const { request, sink } = pending;
    if (Date.now() >= request.expiresAt || !this.lease.isAgentOwner(request.terminalId)
      || this.lease.currentGeneration(request.terminalId) !== request.terminalGeneration || !sink.isWaiting(request)) {
      this.close(requestId, 'expired');
      return false;
    }
    if (request.kind === 'confirmation' && !request.choices?.includes(answer)) return false;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    this.publisher.closed(requestId);
    let delivered = false;
    try { delivered = await sink.deliver(request, answer); }
    finally { pending.resolve(delivered ? 'submitted' : 'expired'); }
    return delivered;
  }

  cancel(requestId: string): void { this.close(requestId, 'canceled'); }

  cancelForTerminal(terminalId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.request.terminalId === terminalId) this.close(pending.request.id, 'expired');
    }
  }

  private close(requestId: string, status: 'canceled' | 'expired'): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    this.publisher.closed(requestId);
    pending.resolve(status);
  }
}
