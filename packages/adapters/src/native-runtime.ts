import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NativeArtifact, RuntimeOperationPlan } from '@cloudhelm/core';
import type { ClientChannel } from 'ssh2';

export interface InstalledNativeRuntime {
  artifact: NativeArtifact; executable: string; directory: string; sessionId: string; generation: number;
  hostId: string; terminalGeneration: number;
}

/** Bounded nonrecursive deletion. Unexpected files, symlinks, identity or digest changes fail closed. */
export async function cleanupNativeRuntime(plan: RuntimeOperationPlan,
  exec: (command: string) => Promise<{ exitCode: number; output: string }>, assertAuthorized: () => void): Promise<void> {
  const base = path.posix.dirname(plan.directory); const leaf = path.posix.basename(plan.directory);
  if (plan.action !== 'cleanup' || !/^cloudhelm-run-[a-f0-9-]{36}$/u.test(leaf)
    || plan.executable !== `${plan.directory}/helper` || !path.posix.isAbsolute(base)
    || !/^[a-f0-9]{64}$/u.test(plan.artifact.sha256)) throw new Error('Invalid runtime cleanup plan');
  const script = ['set -eu', `cd -- ${quoteRemote(base)}`, `test "$(pwd -P)" = ${quoteRemote(base)}`,
    `test ! -L ${quoteRemote(leaf)}`, `cd -- ${quoteRemote(leaf)}`, 'test ! -L helper', 'test -f helper',
    `printf '%s  helper\\n' ${quoteRemote(plan.artifact.sha256)} | sha256sum -c - >/dev/null`,
    'rm -- helper', 'cd ..', `rmdir -- ${quoteRemote(leaf)}`, `test ! -e ${quoteRemote(leaf)}`, "printf 'runtime-cleaned\\n'"].join('\n');
  assertAuthorized(); const result = await exec(script); assertAuthorized();
  if (result.exitCode !== 0 || result.output.trim() !== 'runtime-cleaned') throw new Error('Runtime cleanup unconfirmed; inspect the recorded directory before retrying');
}
export const quoteRemote = (value: string): string => `'${value.replace(/'/gu, `'"'"'`)}'`;

/** The manifest is shipped with the application; no remote-selected download URL. */
export async function nativeArtifact(arch: NativeArtifact['arch'], resources?: string): Promise<{ artifact: NativeArtifact; bytes: Buffer }> {
  const root = resources ?? process.env.CLOUDHELM_NATIVE_DIR;
  if (!root) throw new Error('Bundled native runtime directory is unavailable');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
    protocolVersion: number; toolchain: string; artifacts: Array<NativeArtifact & { filename: string }>;
  };
  const item = manifest.artifacts.find((entry) => entry.platform === 'linux' && entry.arch === arch);
  if (manifest.protocolVersion !== 1 || manifest.toolchain !== 'go1.27.3' || !item || item.protocolVersion !== 1
    || item.filename !== `cloudhelm-helper-linux-${arch}` || !/^[a-f0-9]{64}$/u.test(item.sha256)
    || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > 32 * 1024 * 1024) throw new Error('Invalid native runtime manifest');
  const bytes = await readFile(path.join(root, item.filename));
  if (bytes.length !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.sha256
    || bytes.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error('Bundled native runtime checksum mismatch');
  const { filename: _, ...artifact } = item;
  return { artifact, bytes };
}

/** Bytes travel through a fixed SSH exec stream; SFTP and remote interpreters are not used. */
export async function installNativeRuntime(plan: RuntimeOperationPlan, bytes: Buffer,
  open: (command: string) => Promise<ClientChannel>, assertAuthorized: () => void, signal?: AbortSignal): Promise<void> {
  if (createHash('sha256').update(bytes).digest('hex') !== plan.artifact.sha256 || bytes.length !== plan.artifact.size) throw new Error('Artifact changed after review');
  const base = path.posix.dirname(plan.directory); const leaf = path.posix.basename(plan.directory);
  if (plan.action !== 'install' || !/^cloudhelm-run-[a-f0-9-]{36}$/u.test(leaf)
    || plan.executable !== `${plan.directory}/helper` || !path.posix.isAbsolute(base)) throw new Error('Invalid installation plan');
  assertAuthorized(); signal?.throwIfAborted();
  const script = [
    'set -eu', 'umask 077', 'test -x /bin/bash', 'command -v sha256sum >/dev/null',
    `cd -- ${quoteRemote(base)}`, `test "$(pwd -P)" = ${quoteRemote(base)}`,
    `mkdir -- ${quoteRemote(leaf)}`, `cd -- ${quoteRemote(leaf)}`, 'cat > helper',
    `test "$(wc -c < helper)" -eq ${bytes.length}`,
    `printf '%s  helper\\n' ${quoteRemote(plan.artifact.sha256)} | sha256sum -c - >/dev/null`,
    'chmod 0700 helper', './helper --version'
  ].join('\n');
  const channel = await open(script);
  await new Promise<void>((resolve, reject) => {
    let output = ''; let exitCode: number | undefined; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { channel.close(); reject(error); } else resolve();
    };
    const abort = () => finish(new Error('Native preparation interrupted; business operation not started, runtime directory requires verification'));
    const timer = setTimeout(abort, 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    channel.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 4096) finish(new Error('Invalid native runtime response')); });
    channel.stderr.on('data', () => {});
    channel.on('error', () => finish(new Error('Native preparation connection failed; business operation not started')));
    channel.on('exit', (code: number) => { exitCode = code; });
    channel.on('close', () => {
      if (exitCode !== 0) return finish(new Error('Native preparation failed (directory, permissions, noexec, or protocol); business operation not started'));
      try { if (JSON.parse(output).protocolVersion !== 1) throw new Error(); assertAuthorized(); finish(); }
      catch { finish(new Error('Native runtime protocol or authorization changed; business operation not started')); }
    });
    try { assertAuthorized(); signal?.throwIfAborted(); channel.end(bytes); } catch { abort(); }
  });
}
