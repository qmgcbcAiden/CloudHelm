import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { nativeArtifact, type SshTransport, type InstalledNativeRuntime } from '@cloudhelm/adapters';
import type { SafetyGate, TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, type ExecutionOptions, type OperationExecutor, type OperationResult,
  type OperationScope, type ProposedOperation, type RuntimeOperationPlan } from '@cloudhelm/core';
import type { RuntimeResourceView } from '@cloudhelm/contracts';

type RuntimeOperation = Extract<ProposedOperation, { kind: 'runtime' }>;
export type RuntimeResource = RuntimeResourceView;
interface OwnedResource { record: RuntimeResource; scope: OperationScope; transport: SshTransport; uncertain?: boolean;
  cleanup?: (current: () => void) => Promise<void> }
interface Grant { operation: RuntimeOperation; transport: SshTransport; run?: (current: () => void) => Promise<void>; bytes?: Buffer; resource?: OwnedResource }
const sessionKey = (task: string, session: string) => JSON.stringify([task, session]);

/** Backend-only capabilities plus one durable record per physical runtime directory. */
export class NativeRuntimePreparation implements OperationExecutor {
  private readonly pending = new Map<string, Grant>();
  private readonly resources = new Map<string, OwnedResource>();
  private readonly retired = new Map<string, () => void>();
  private readonly cleanups = new Map<string, Promise<void>>();
  constructor(private readonly terminal: TerminalManager,
    private readonly persist: (record: RuntimeResource) => Promise<void>) {}

  async ensure(operation: ProposedOperation, gate: SafetyGate, transport: SshTransport,
    base = '/tmp', signal?: AbortSignal, purpose: RuntimeOperationPlan['purpose'] = 'execute'): Promise<InstalledNativeRuntime> {
    const session = operation.scope.sessionId ?? operation.scope.terminalId;
    let info = transport.nativeInfo(operation.scope.hostId, session, operation.scope.terminalGeneration);
    if (!info) {
      const { artifact, bytes } = await nativeArtifact(await transport.nativeArchitecture(operation.scope.hostId));
      const directory = path.posix.join(base, `cloudhelm-run-${randomUUID()}`);
      const plan: RuntimeOperationPlan = { version: 1, action: 'install', directory, executable: `${directory}/helper`,
        artifact, sessionId: session, purpose, parentOperationId: operation.id };
      await this.review(operation, plan, gate, transport, signal, bytes);
      info = transport.nativeInfo(operation.scope.hostId, session, operation.scope.terminalGeneration);
      if (!info) throw new Error('Native runtime was not installed; business operation not started');
    }
    const owned = [...this.resources.values()].find((item) => item.record.plan.directory === info!.directory && item.transport === transport);
    if (!owned || owned.record.state !== 'ready' || owned.uncertain) throw new Error('Runtime ownership is unconfirmed; business operation not started');
    await this.review(operation, { version: 1, action: 'launch', directory: info.directory,
      executable: info.executable, artifact: info.artifact, sessionId: session, purpose, parentOperationId: operation.id }, gate, transport, signal);
    return info;
  }

  async bootstrap(operation: ProposedOperation, plan: RuntimeOperationPlan, gate: SafetyGate,
    transport: SshTransport, run: (current: () => void) => Promise<void>, signal?: AbortSignal): Promise<void> {
    await this.review(operation, plan, gate, transport, signal, undefined, run);
  }

  /** Revoke business access immediately, retaining the connection solely for reviewed cleanup. */
  retireSession(taskId: string, sessionId: string, close: () => void,
    rootCleanup?: (current: () => void) => Promise<void>): boolean {
    const owned = [...this.resources.values()].filter((item) => item.record.taskId === taskId && item.record.plan.sessionId === sessionId);
    if (!owned.length) return false;
    for (const item of owned) {
      item.uncertain ||= this.terminal.hasPending(item.record.terminalId);
      if (item.record.plan.action === 'su-bootstrap') item.cleanup = rootCleanup;
    }
    this.retired.set(sessionKey(taskId, sessionId), close);
    return true;
  }

  cleanupTask(taskId: string, gate: SafetyGate, refresh: (scope: OperationScope) => OperationScope = (scope) => scope): Promise<void> {
    const previous = this.cleanups.get(taskId); if (previous) return previous;
    const work = this.cleanupOwned(taskId, gate, refresh).finally(() => this.cleanups.delete(taskId));
    this.cleanups.set(taskId, work); return work;
  }

  private async cleanupOwned(taskId: string, gate: SafetyGate, refresh: (scope: OperationScope) => OperationScope): Promise<void> {
    const owned = [...this.resources.values()].filter((item) => item.record.taskId === taskId);
    // Root sessions must be cleaned while their authenticated controller is still alive.
    owned.sort((a, b) => Number(b.record.plan.action === 'su-bootstrap') - Number(a.record.plan.action === 'su-bootstrap'));
    const hasPending = this.terminal.pendingOperations(taskId).length > 0;
    try {
      for (const resource of owned) {
        if (resource.record.state === 'closed' || resource.record.state === 'unknown') continue;
        if (hasPending || resource.uncertain || resource.record.state !== 'ready'
          || resource.transport.connectionGeneration(resource.record.hostId) !== resource.record.generation) {
          await this.transition(resource, 'unknown'); continue;
        }
        const refreshedScope = refresh(resource.scope);
        const terminalId = this.terminal.open(resource.record.hostId,
          { onData() {}, onClose() {}, close() {} }, taskId,
          path.posix.dirname(resource.record.plan.directory));
        const parent: RuntimeOperation = { id: randomUUID(), kind: 'runtime', runtime: { ...resource.record.plan, action: 'cleanup' },
          scope: { ...refreshedScope, terminalId, terminalGeneration: this.terminal.currentGeneration(terminalId),
            cwd: path.posix.dirname(resource.record.plan.directory), runAs: resource.record.runAs, loginAs: resource.record.loginAs } };
        try { await this.review(parent, parent.runtime, gate, resource.transport, undefined, undefined, undefined, resource); }
        catch { if (!['unknown', 'closed'].includes(resource.record.state)) await this.transition(resource, 'unknown'); }
        finally { this.terminal.close(terminalId); }
      }
    } finally {
      for (const [key, close] of [...this.retired]) if (JSON.parse(key)[0] === taskId) {
        this.retired.delete(key); try { close(); } catch { /* Resource state remains durable and no retry is attempted. */ }
      }
    }
  }

  async markUnknown(hostId?: string, taskId?: string): Promise<void> {
    await Promise.all([...this.resources.values()].filter((item) => (!hostId || item.record.hostId === hostId)
      && (!taskId || item.record.taskId === taskId)).map(async (item) => {
      item.uncertain = true;
      if (!['closed', 'unknown'].includes(item.record.state)) await this.transition(item, 'unknown');
    }));
  }

  /** Recovery must not delete through an unresolved business lock or retain its root connection. */
  async abandonSession(taskId: string, sessionId: string): Promise<void> {
    try {
      await Promise.all([...this.resources.values()].filter((item) => item.record.taskId === taskId
        && item.record.plan.sessionId === sessionId).map(async (item) => {
        item.uncertain = true;
        if (!['closed', 'unknown'].includes(item.record.state)) await this.transition(item, 'unknown');
      }));
    } finally {
      const key = sessionKey(taskId, sessionId); const close = this.retired.get(key);
      this.retired.delete(key); close?.();
    }
  }

  private async transition(resource: OwnedResource, state: RuntimeResource['state']): Promise<void> {
    const record = { ...resource.record, state, revision: resource.record.revision + 1, updatedAt: Date.now() };
    await this.persist(record); resource.record = record;
  }

  private async review(parent: ProposedOperation, plan: RuntimeOperationPlan, gate: SafetyGate,
    transport: SshTransport, signal?: AbortSignal, bytes?: Buffer, run?: (current: () => void) => Promise<void>, resource?: OwnedResource): Promise<void> {
    const operation: RuntimeOperation = { id: randomUUID(), kind: 'runtime', runtime: plan,
      scope: { ...parent.scope, runAs: plan.action === 'su-bootstrap' || resource?.record.plan.action === 'su-bootstrap'
        ? 'root' : parent.scope.loginAs ?? parent.scope.runAs } };
    this.pending.set(operation.id, { operation, transport, bytes, run, resource });
    try {
      const outcome = await gate.execute(operation, signal);
      if (outcome.result?.status !== 'succeeded') throw new Error(outcome.result?.stdoutTail ?? `Native preparation not authorized: ${outcome.decision.reason}`);
    } finally { this.pending.delete(operation.id); }
  }

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (operation.kind !== 'runtime') throw new Error('Not a runtime operation');
    const grant = this.pending.get(operation.id);
    const generation = grant?.transport.connectionGeneration(operation.scope.hostId);
    const current = () => {
      if (!grant || operationFingerprint(grant.operation) !== fingerprint || operationFingerprint(operation) !== fingerprint
        || !options?.isAuthorized?.() || signal?.aborted || generation !== grant.transport.connectionGeneration(operation.scope.hostId)
        || !this.terminal.isAgentOwner(operation.scope.terminalId)
        || this.terminal.currentGeneration(operation.scope.terminalId) !== operation.scope.terminalGeneration) throw new Error('Runtime authorization expired');
    };
    let dispatched = false; let resource = grant?.resource;
    try {
      current();
      const action = operation.runtime.action;
      if (action === 'install' || action === 'su-bootstrap') {
        const record: RuntimeResource = { id: operation.id, taskId: operation.scope.taskId, hostId: operation.scope.hostId,
          terminalId: operation.scope.terminalId, terminalGeneration: operation.scope.terminalGeneration,
          loginAs: operation.scope.loginAs ?? operation.scope.runAs, runAs: operation.scope.runAs,
          generation: generation!, plan: operation.runtime, state: 'prepared', revision: 1, updatedAt: Date.now() };
        await this.persist(record); resource = { record, scope: structuredClone(operation.scope), transport: grant!.transport };
        this.resources.set(record.id, resource); current();
      }
      if (action === 'install') {
        if (!grant!.bytes) throw new Error('Runtime artifact unavailable');
        dispatched = true;
        await grant!.transport.installNative(operation.scope.hostId, operation.runtime, grant!.bytes, current, signal, operation.scope.terminalGeneration);
      } else if (action === 'su-bootstrap') {
        if (!grant!.run) throw new Error('Root runtime bootstrap unavailable');
        dispatched = true; await grant!.run(current);
      } else if (action === 'cleanup') {
        if (!resource || resource.record.state !== 'ready' || resource.uncertain || this.terminal.pendingOperations(resource.record.taskId).length)
          throw new Error('Runtime cleanup requires a known idle resource');
        await this.transition(resource, 'cleaning'); current(); dispatched = true;
        if (resource.record.plan.action === 'su-bootstrap') {
          if (!resource.cleanup) throw new Error('Root cleanup controller unavailable');
          await resource.cleanup(current);
        } else await grant!.transport.cleanupNative(operation.scope.hostId, operation.runtime, resource.record.terminalGeneration, current);
      } else if (action !== 'launch') throw new Error('Runtime lifecycle action unsupported');
      current();
      if (resource) await this.transition(resource, action === 'cleanup' ? 'closed' : 'ready');
      return { operationId: operation.id, status: 'succeeded', exitCode: 0, effects: action === 'launch' ? 'none' : 'possible',
        stdoutTail: `Native runtime ${action} confirmed at ${operation.runtime.directory}.` };
    } catch (error) {
      if (resource && resource.record.state !== 'unknown') {
        resource.uncertain = true;
        try { await this.transition(resource, 'unknown'); } catch { /* The last durable intent remains; never retry a lost ACK. */ }
      }
      return { operationId: operation.id, status: dispatched ? 'unknown' : 'failed', effects: dispatched ? 'possible' : 'none',
        failureKind: 'unsupported', stdoutTail: `${error instanceof Error ? error.message : 'Runtime unavailable'}; inspect the recorded resource before retrying.` };
    }
  }
}
