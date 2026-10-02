import { describe, expect, it } from 'vitest';
import { BashAnalyzer } from './bash-analyzer.js';
import { decideSafety, isReadOnlyQuery, type ProposedOperation } from '@cloudhelm/core';

const scope = {
  taskId: 'task-1', hostId: 'host-1', cwd: '/srv/app', runAs: 'deploy',
  terminalId: 'terminal-1', terminalGeneration: 1, policyRevision: 1,
  allowedWorkingRoots: ['/srv/app'], protectedPaths: ['/srv/backup'], goal: 'Deploy the app'
};

function command(value: string): Extract<ProposedOperation, { kind: 'command' }> {
  return { id: 'operation-1', kind: 'command', command: value, scope };
}

const analyzer = new BashAnalyzer();

describe('deterministic safety policy', () => {
  it.each(['rm -rf /', 'rm -rf /etc/', 'rm -rf /usr/*', 'echo ok; rm -rf /*', 'sudo rm -rf /etc', "bash -c 'rm -rf /'", 'dd if=/dev/zero of=/dev/sda', 'mkfs.ext4 /dev/sdb', 'cat /dev/zero > /dev/sda', 'chmod -R 777 /'])('rejects known catastrophic effect: %s', async (value) => {
    const operation = command(value);
    const decision = decideSafety(operation, { mode: 'permissive', revision: 1 }, await analyzer.analyze(value));
    expect(decision.verdict).toBe('deny');
  });

  it.each([
    "sudo bash -c 'rm -rf /'", "env bash -lc 'rm -rf /etc'", "su deploy -c 'rm -rf /'",
    "sudo -u root -- env X=1 sh -xc 'rm -rf /*'", "su --command='mkfs.ext4 /dev/sda' root",
    "command sudo --user=root sh -c 'chmod -R 777 /'", "env -S 'bash -c \"rm -rf /\"'",
    "bash -c 'r'\"m -rf /\"", "nohup /bin/bash -c 'dd of=/dev/sda if=/dev/zero'"
  ])('finds forbidden effects under wrappers: %s', async (value) => {
    expect(decideSafety(command(value), { mode: 'permissive', revision: 1 }, await analyzer.analyze(value)).verdict).toBe('deny');
  });

  it.each(['ls -la /srv/app', 'pwd', 'ifconfig -a', 'mkdir -p ./cache', 'cd ./cache', 'cat /srv/app/config', 'cat -- ./config'])('allows bounded low-risk operation: %s', async (value) => {
    const operation = command(value);
    const decision = decideSafety(operation, { mode: 'ask', revision: 1 }, await analyzer.analyze(value));
    expect(decision.verdict).toBe('allow');
  });

  it.each(['ifconfig eth0 down', 'ls $(touch /tmp/foo)', 'echo text > /tmp/file', 'mkdir -p /etc/other'])('does not whitelist a command name with extra effects: %s', async (value) => {
    const operation = command(value);
    const decision = decideSafety(operation, { mode: 'ask', revision: 1 }, await analyzer.analyze(value));
    expect(decision.verdict).toBe('ask');
  });

  it('blocks a user-protected directory through a command and a structured write', async () => {
    const operation = command('rm -rf /srv/backup');
    expect(decideSafety(operation, { mode: 'permissive', revision: 1 }, await analyzer.analyze(operation.command)).verdict).toBe('deny');
    const write: ProposedOperation = { id: 'write-1', kind: 'write-file', path: '/srv/backup/secrets', content: 'new', scope };
    expect(decideSafety(write, { mode: 'permissive', revision: 1 }).verdict).toBe('deny');
    const read = command('ls /srv/backup');
    expect(decideSafety(read, { mode: 'permissive', revision: 1 }, await analyzer.analyze(read.command)).verdict).toBe('deny');
  });

  it('prevents structured uploads outside the selected local root', () => {
    const upload: ProposedOperation = { id: 'upload-1', kind: 'upload', localPath: '/Users/alice/secrets', localRoot: '/Users/alice/project', remotePath: '/srv/app/secrets', contentSha256: 'a', size: 1, scope };
    expect(decideSafety(upload, { mode: 'permissive', revision: 1 }).verdict).toBe('deny');
  });

  it('requires AI review for an ordinary mutation in level two', async () => {
    const operation = command('docker compose up -d');
    expect(decideSafety(operation, { mode: 'ai-review', revision: 1 }, await analyzer.analyze(operation.command)).verdict).toBe('evaluate');
  });

  it('stops execution when the analyzer cannot establish a complete parse', async () => {
    const operation = command('echo foo; )');
    expect(decideSafety(operation, { mode: 'permissive', revision: 1 }, await analyzer.analyze(operation.command)).verdict).toBe('error');
  });
  it.each([
    'rm -rf $(echo /)', 'rm -rf "$(printf %s /)etc"', 'echo bad > $(echo /dev/sda)',
    'rm -rf /{etc,usr}', 'find / -exec rm {} \\;', 'mv /etc /tmp/old', 'rsync -a --delete ./empty/ /',
    'rm -r /', 'sudo -uroot rm -r /etc', 'busybox rm -rf /',
    'timeout 3 nice -n 1 rm -rf /usr', 'xargs -n 1 rm -rf /',
    'find /tmp -exec rm -rf / \\;', 'echo "$(sudo rm -rf /)"',
    'cd /; rm -rf .', 'cd /etc; rm -rf *',
    "eval 'rm -rf /'", "env -S'bash -c \"rm -rf /\"'",
    "$'\\162m' -rf /", 'dd of=/dev/mapper/root if=/dev/zero',
    'echo hi > /dev/mmcblk0', 'tee /dev/nvme0n1p1',
    'truncate -s 0 /etc/passwd', 'echo bad > /etc/fstab',
    `python3 -c 'import os; os.system("rm -rf /")'`,
    `python3 -c 'import os; os.system("echo ok"); os.system("rm -rf /")'`,
    `python3 -c 'import shutil; shutil.rmtree("/")'`,
    `node -e 'require("fs").rmSync("/", {recursive: true})'`
  ])('blocks common literal bypass forms: %s', async (value) => {
    expect(decideSafety(command(value), { mode: 'permissive', revision: 1 }, await analyzer.analyze(value)).verdict).toBe('deny');
  });

  it.each(['rm -rf /srv', 'cat /srv/backup/*', 'cp /srv/backup/secret ./out', 'tee /srv/backup/secret', 'chmod -R 777 /srv/backup', 'rm -rf /srv/back*', 'cd /srv; rm -rf backup'])('protects resources and destructive ancestors: %s', async (value) => {
    expect(decideSafety(command(value), { mode: 'permissive', revision: 1 }, await analyzer.analyze(value)).verdict).toBe('deny');
  });

  it.each(['cat', 'cat -', 'cat -- -', 'cat -n file', 'cat --help', 'cat ~', 'cat /dev/stdin', 'cat \"file\tname\"', 'cat $(echo /tmp/file)', 'PATH=/tmp ls', 'LD_PRELOAD=/tmp/hook.so id', 'pwd &', 'hostname new-name', 'date 010100002026', 'date --set now', '/tmp/ls /', 'mkdir -p /srv/app/cache', 'cd /srv/app', 'ls; pwd', 'ls $(touch /tmp/changed)'])('does not mint a read-only capability for %s', async (value) => {
    expect(isReadOnlyQuery(await analyzer.analyze(value))).toBe(false);
  });

  it.each(['ls -la /srv/app', 'pwd', 'hostname -I', 'date -u', 'id deploy', 'cat /srv/app/config', 'cat -- ./config ./logs/run.log'])('recognizes a pure read-only query: %s', async (value) => {
    expect(isReadOnlyQuery(await analyzer.analyze(value))).toBe(true);
  });

});
