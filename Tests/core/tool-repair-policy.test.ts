import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { decideSafety, operationFingerprint, operationIntentKey, buildCommandExecutionPlan, type ProposedOperation } from '@cloudhelm/core';
const scope = { taskId: 'task', hostId: 'host', terminalId: 'terminal', terminalGeneration: 1, policyRevision: 1,
  runAs: 'user', loginAs: 'user', cwd: '/srv', allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'configure service' };
it.each(['/etc/cron.d/app', '/etc/crontab', '/var/spool/cron/root', '/etc/systemd/system/app.service',
  '/usr/lib/systemd/system/app.service', '/etc/profile.d/app.sh', '/root/.bashrc', '/root/.bash_profile', '/etc/zsh/zshrc',
  '/home/user/.bashrc', '/home/user/.profile', '/home/user/.zshenv', '/opt/account/.bash_profile',
  '/home/user/.config/systemd/user/app.service', '/root/.config/systemd/user/app.service',
  '/home/user/.local/share/systemd/user/app.service', '/etc/systemd/user/app.service', '/usr/lib/systemd/user/app.service',
  '/usr/local/lib/systemd/user/app.service', '/home/user/.config/fish/config.fish', '/home/user/.config/fish/conf.d/start.fish'])('F4 keeps %s high impact across structured and shell mutation', async (target) => {
  const analyzer = new BashAnalyzer();
  for (const mode of ['ask', 'ai-review', 'permissive'] as const) {
    for (const op of [
      { id: 'write', kind: 'write-file', path: target, content: 'new', scope },
      { id: 'delete', kind: 'delete-path', path: target, scope },
      { id: 'upload', kind: 'upload', localPath: '/local/input', localRoot: '/local', remotePath: target, size: 3, contentSha256: 'a'.repeat(64), scope }
    ] as ProposedOperation[]) expect(decideSafety(op, { mode, revision: 1 })).toMatchObject({ impact: 'high', verdict: mode === 'ai-review' ? 'evaluate' : 'ask' });
    const command = `printf new > '${target}'`;
    expect(decideSafety({ id: 'shell', kind: 'command', command, scope }, { mode, revision: 1 }, await analyzer.analyze(command)))
      .toMatchObject({ impact: 'high', verdict: mode === 'ai-review' ? 'evaluate' : 'ask' });
  }
});
it('T4/R3 fingerprint binds the exact reviewed launch while replay identity remains semantic', async () => {
  const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'sudo -u deploy id', scope };
  const planned = { ...operation, executionPlan: buildCommandExecutionPlan(await new BashAnalyzer().analyze(operation.command), 'user') };
  expect(operationFingerprint(planned)).not.toBe(operationFingerprint(operation));
  expect(operationIntentKey(planned)).toBe(operationIntentKey(operation));
  const changed = structuredClone(planned); changed.executionPlan.steps[0]!.argv.push('different');
  expect(operationFingerprint(changed)).not.toBe(operationFingerprint(planned));
});
it('T1 protects native setup paths even in permissive mode', () => {
  const directory = '/tmp/cloudhelm-run-00000000-0000-4000-8000-000000000000';
  const operation: ProposedOperation = { id: 'setup', kind: 'runtime', scope: { ...scope, protectedWritePaths: ['/tmp'] },
    runtime: { version: 1, action: 'install', directory, executable: `${directory}/helper`, sessionId: 'session', parentOperationId: 'business',
      purpose: 'recover', artifact: { platform: 'linux', arch: 'arm64', protocolVersion: 1, sha256: 'a'.repeat(64), size: 1024 } } };
  expect(decideSafety(operation, { mode: 'permissive', revision: 1 }).ruleId).toBe('protected-runtime-path');
});
