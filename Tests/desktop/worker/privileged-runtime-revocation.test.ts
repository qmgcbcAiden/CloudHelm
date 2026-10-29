import { beforeEach, expect, it, vi } from 'vitest';
import { SafetyGate, TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, SshTransport, type InstalledNativeRuntime } from '@cloudhelm/adapters';
import type { OperationResult, ProposedOperation, RuntimeOperationPlan } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { NativeRuntimePreparation, type RuntimeResource } from '../../../apps/desktop/src/worker/native-runtime-preparation.js';
import { PrivilegedRuntime } from '../../../apps/desktop/src/worker/privileged-runtime.js';

const state = vi.hoisted(() => ({ answers: [] as string[], rootCopies: 0, bootstraps: 0, commands: [] as string[] }));
vi.mock('@cloudhelm/adapters', async (original) => ({
  ...await original<typeof import('@cloudhelm/adapters')>(),
  nativeArtifact: async () => ({ artifact: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'a'.repeat(64), size: 7 }, bytes: Buffer.from('fixture') }),
  SshTransport: class {
    readonly installed = new Map<string, InstalledNativeRuntime>();
    connectionGeneration() { return 1; }
    nativeArchitecture() { return Promise.resolve('amd64'); }
    nativeInfo(host: string, session: string, generation: number) { return this.installed.get(JSON.stringify([host, session, generation])); }
    async installNative(hostId: string, plan: RuntimeOperationPlan, _bytes: Buffer, current: () => void, _signal: AbortSignal | undefined, terminalGeneration: number) {
      current(); this.installed.set(JSON.stringify([hostId, plan.sessionId, terminalGeneration]), { hostId, sessionId: plan.sessionId,
        terminalGeneration, generation: 1, artifact: plan.artifact, directory: plan.directory, executable: plan.executable });
    }
    close() {}
  },
  SuSession: class {
    async connect(authenticate: () => Promise<string | null>, current: () => void) {
      current(); state.bootstraps++;
      const answer = await authenticate();
      // Match SuSession's final authorization check immediately before the private answer write.
      current();
      if (answer === null) throw new Error('cancelled');
      state.answers.push(answer); state.rootCopies++;
    }
    close() {}
  },
  SshCommandTerminal: class {
    readonly agent = this;
    data = (_text: string) => {}; exit = (_code: number) => {};
    onData(callback: typeof this.data) { this.data = callback; }
    onExit(callback: typeof this.exit) { this.exit = callback; }
    onClose() {} onDisplay() {} close() {}
    async execute(command: string, _cwd: string, current: () => boolean) {
      if (!current()) throw new Error('expired');
      state.commands.push(command); this.data('0\n'); this.exit(0);
    }
  }
}));

beforeEach(() => { state.answers = []; state.rootCopies = 0; state.bootstraps = 0; state.commands = []; });

it.each(['host-policy', 'conversation-policy', 'reviewer-policy'] as const)('revokes the su bootstrap lease before delivering a password when %s changes', async (changed) => {
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const resources: RuntimeResource[] = []; const proposals: ProposedOperation[] = []; const results: OperationResult[] = [];
  const native = new NativeRuntimePreparation(terminal, async (resource) => { resources.push(structuredClone(resource)); });
  let answer!: (secret: string) => void;
  const input = vi.fn(async (request: { kind: string }) => request.kind === 'confirmation' ? '通过 su 切换 root'
    : new Promise<string>((resolve) => { answer = resolve; }));
  const privileged = new PrivilegedRuntime({ terminal, ssh: new SshTransport(), runtime: native, input,
    commands: { execute: terminal.execute.bind(terminal) }, ordinary: { execute: vi.fn() },
    files: () => { throw new Error('No files in authentication fixture'); }, jump: () => undefined });
  const settings = { mode: 'permissive' as const, revision: 1, conversationRevision: 1, reviewerRevision: 1 };
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), evaluator: { evaluate: async () => 'allow' },
    executor: { execute: (operation, fingerprint, signal, options) =>
      (operation.kind === 'runtime' ? native : privileged).execute(operation, fingerprint, signal, options) },
    lease: terminal, settings: () => settings, approvals: { requestApproval: async () => true }, audit: {
      proposed: async (operation) => { proposals.push(operation); }, decided: async () => {}, completed: async (result) => { results.push(result); }
    } });
  const access = privileged.forTask('task');
  const requesting = access.request(host, 'touch /root/fixture', '/', 'fixture', 'fixture', gate, undefined, undefined, 'su', 'execute',
    { conversationRevision: 1, reviewerRevision: 1 });
  await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(2));
  const bootstrap = proposals.find((operation) => operation.kind === 'runtime' && operation.runtime.action === 'su-bootstrap')!;
  expect(bootstrap.scope).toMatchObject({ policyRevision: 1, conversationRevision: 1, reviewerRevision: 1 });
  if (changed === 'host-policy') settings.revision++;
  else if (changed === 'conversation-policy') settings.conversationRevision++;
  else settings.reviewerRevision++;
  answer('private-fixture-password');
  await expect(requesting).rejects.toThrow();
  expect(state.bootstraps).toBe(1); expect(state.answers).toEqual([]); expect(state.rootCopies).toBe(0); expect(state.commands).toEqual([]);
  expect(results.find((result) => result.operationId === bootstrap.id)).toMatchObject({ status: 'unknown', effects: 'possible' });
  expect(resources.filter((resource) => resource.plan.action === 'su-bootstrap').at(-1)?.state).toBe('unknown');
  await native.abandonSession('task', bootstrap.scope.sessionId!);
});
