import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { buildCommandExecutionPlan, type RuntimeOperationPlan } from '@cloudhelm/core';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { nativeArtifact } from '../../packages/adapters/src/native-runtime.js';
import { HostKeyError, SshTransport, type SshHost } from '../../packages/adapters/src/ssh-transport.js';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';
import { SuSession } from '../../packages/adapters/src/su-session.js';

// Privilege tests run only in the disposable CI fixture, never on a generic
// opt-in SSH target. These public synthetic passwords are fixture data.
const isolated = process.env.CLOUDHELM_ISOLATED_FIXTURE === '1';
const run = isolated ? it : it.skip;
if (isolated && !process.env.CLOUDHELM_TEST_SSH_KEY) throw new Error('The isolated fixture SSH key is required');

run('streams an absent runtime and executes real Bash, sudo and su through the TS protocol state machine', async () => {
  const ssh = new SshTransport();
  const host: SshHost = { id: 'isolated-native', label: 'Disposable fixture', address: '127.0.0.1',
    port: Number(process.env.CLOUDHELM_TEST_SSH_PORT ?? '22388'), username: 'cloudhelm', auth: 'private-key', privateKeyPath: process.env.CLOUDHELM_TEST_SSH_KEY };
  let runtime: RuntimeOperationPlan | undefined;
  let installed = false;
  let root: SuSession | undefined;
  try {
    try { await ssh.connect(host, {}); } catch (error) {
      expect(error).toBeInstanceOf(HostKeyError); host.fingerprint = (error as HostKeyError).fingerprint;
    }
    expect(host.fingerprint).toMatch(/^SHA256:/u); await ssh.connect(host, {});
    const environment = await ssh.execFixed(host.id, 'test ! -e /home/cloudhelm/runtime/helper && ! command -v python && ! command -v python3');
    expect(environment.exitCode).toBe(0);
    await expect(ssh.list(host.id, '/tmp')).rejects.toBeTruthy();
    const { artifact, bytes } = await nativeArtifact(await ssh.nativeArchitecture(host.id), fileURLToPath(new URL('../../apps/desktop/resources/native/', import.meta.url)));
    const directory = `/tmp/cloudhelm-run-${randomUUID()}`;
    runtime = { version: 1, action: 'install', directory, executable: `${directory}/helper`, artifact, sessionId: randomUUID(), purpose: 'execute' };
    expect(ssh.nativeInfo(host.id, runtime.sessionId, 1)).toBeUndefined();
    await ssh.installNative(host.id, runtime, bytes, () => {}); installed = true;
    expect(ssh.nativeInfo(host.id, runtime.sessionId, 1)?.artifact.sha256).toBe(artifact.sha256);

    const execute = async (transport: CommandTransport, command: string, runAs: string, cwd = '/tmp') => {
      const terminal = new SshCommandTerminal(transport, host.id);
      const operationId = randomUUID(); let output = ''; let challenges = 0;
      const plan = buildCommandExecutionPlan(await new BashAnalyzer().analyze(command), runAs);
      terminal.onData((data) => { output += data; });
      terminal.agent.onAuthentication!((challenge) => {
        if (!challenge.prompt) return;
        expect(challenge.mechanism).toBe('sudo'); expect(challenge.promptSha256).toMatch(/^[a-f0-9]{64}$/u);
        challenges++; expect(terminal.agent.answerAuthentication!(challenge.id, 'fixture-login-password')).toBe(true);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = new Promise<number | undefined>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native TS command did not produce a verified completion')), 15_000);
        terminal.agent.onExit!((code) => { clearTimeout(timer); resolve(code); });
      });
      try {
        await terminal.agent.execute(command, cwd, () => true, { operationId, sessionId: runtime!.sessionId, generation: 1, plan });
        const code = await completed;
        expect(output).not.toContain('fixture-login-password'); expect(output).not.toContain('fixture-root-password');
        return { code, output, challenges };
      } finally { clearTimeout(timer); terminal.close(); }
    };

    const ordinary = await execute(ssh, `help cd >/dev/null; shopt -u nullglob; printf '%s:%s' "$HOME" "$USER"`, 'cloudhelm');
    expect(ordinary).toEqual({ code: 0, output: '/home/cloudhelm:cloudhelm', challenges: 0 });
    const sudo = await execute(ssh, 'sudo /usr/bin/printf allowed', 'cloudhelm');
    expect(sudo.code).toBe(0); expect(sudo.output.endsWith('allowed')).toBe(true); expect(sudo.challenges).toBe(1);

    let rootChallenges = 0;
    root = new SuSession(ssh, host.id, new AbortController().signal, () => {});
    await root.connect(async () => { rootChallenges++; return 'fixture-root-password'; }, () => {}, {
      version: 1, operationId: randomUUID(), sessionId: runtime.sessionId, generation: 1,
      rootDirectory: `/tmp/cloudhelm-root-${randomUUID()}`, artifactSha256: artifact.sha256
    });
    expect(rootChallenges).toBe(1);
    expect(await execute(root, 'id -u', 'root', '/root')).toEqual({ code: 0, output: '0\r\n', challenges: 0 });
    const rootSudo = await execute(root, 'sudo /usr/bin/printf allowed', 'root', '/root');
    expect(rootSudo.code).toBe(0); expect(rootSudo.output.endsWith('allowed')).toBe(true); expect(rootSudo.challenges).toBe(0);
    await root.cleanupRuntime(() => {}); root.close(); root = undefined;
  } finally {
    root?.close();
    if (installed && runtime) await ssh.cleanupNative(host.id, { ...runtime, action: 'cleanup' }, 1, () => {});
    ssh.close();
  }
}, 60_000);
