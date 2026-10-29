import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { RuntimeOperationPlan } from '@cloudhelm/core';
import { cleanupNativeRuntime } from '../../packages/adapters/src/native-runtime.js';
import { fixtureBash } from '../bash-fixture.js';
const exec = promisify(execFile);
async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-cleanup-test-')));
  const directory = path.join(base, `cloudhelm-run-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 }); const bytes = Buffer.from('fixture helper image');
  const executable = path.join(directory, 'helper');
  await writeFile(executable, bytes, { mode: 0o700 });
  // Git Bash exposes Windows files through POSIX paths. The production plan is
  // always a remote Linux path, never a Windows path sent to path.posix checks.
  const shellDirectory = (await exec(fixtureBash(), ['--noprofile', '--norc', '-c', 'pwd -P'], { cwd: directory })).stdout.trim();
  const plan: RuntimeOperationPlan = { version: 1, action: 'cleanup', directory: shellDirectory, executable: `${shellDirectory}/helper`,
    sessionId: 'session', purpose: 'execute', parentOperationId: 'operation', artifact: { protocolVersion: 1,
      platform: 'linux', arch: 'amd64', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  const run = async (command: string) => {
    try { return { exitCode: 0, output: (await exec(fixtureBash(), ['--noprofile', '--norc', '-c', command])).stdout }; }
    catch (error) { return { exitCode: Number((error as { code: number }).code), output: String((error as { stdout?: string }).stdout ?? '') }; }
  };
  return { base, directory, executable, plan, run, finish: () => rm(base, { recursive: true, force: true }) };
}

describe('nonrecursive runtime cleanup against a local filesystem', () => {
  it('removes only the matching helper image and its now-empty private directory', async () => {
    const f = await fixture();
    try { await cleanupNativeRuntime(f.plan, f.run, () => {}); await expect(readFile(f.executable)).rejects.toThrow(); }
    finally { await f.finish(); }
  });
  it('refuses a changed helper image without deleting it', async () => {
    const f = await fixture();
    try {
      await writeFile(f.executable, 'changed');
      await expect(cleanupNativeRuntime(f.plan, f.run, () => {})).rejects.toThrow('unconfirmed');
      expect(await readFile(f.executable, 'utf8')).toBe('changed');
    } finally { await f.finish(); }
  });
  it('does not follow a replaced directory symlink or recursively delete unexpected files', async () => {
    const f = await fixture(); const other = path.join(f.base, 'foreign');
    try {
      await mkdir(other); await writeFile(path.join(other, 'keep'), 'preserved');
      await rm(f.directory, { recursive: true }); await symlink(other, f.directory, 'dir');
      await expect(cleanupNativeRuntime(f.plan, f.run, () => {})).rejects.toThrow('unconfirmed');
      expect(await readFile(path.join(other, 'keep'), 'utf8')).toBe('preserved');
    } finally { await f.finish(); }
  });
  it('leaves unexpected content in place and reports an unconfirmed partial cleanup', async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.directory, 'keep'), 'preserved');
      await expect(cleanupNativeRuntime(f.plan, f.run, () => {})).rejects.toThrow('unconfirmed');
      expect(await readFile(path.join(f.directory, 'keep'), 'utf8')).toBe('preserved');
    } finally { await f.finish(); }
  });
});
