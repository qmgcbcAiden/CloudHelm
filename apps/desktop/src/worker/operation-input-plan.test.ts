import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { quoteShell, setupInput, suPayload, type InputPaths } from './operation-input-plan.js';

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

function shell(command: string, input = '', timeoutMs = 3000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', `exec 3>&2; ${command}`], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = ''; let stderr = '';
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      // Kill only this detached test process group. Killing its shell alone leaves
      // FIFO helpers holding stdout/stderr open, so Node never emits `close`.
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error); }
      }
    }, timeoutMs);
    child.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (timedOut) reject(new Error('Local helper process group timed out'));
      else resolve({ stdout, stderr, code });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
  });
}

describe.skipIf(process.platform === 'win32')('real local helper process isolation (no remote authentication)', () => {
  it('closes inherited authentication stdin before running any su payload', async () => {
    const payload = suPayload('if IFS= read -r value; then printf "LEAK:%s" "$value"; else printf no-input; fi', 'AUTH_DONE');
    const result = await shell(payload, 'late-synthetic-secret\n');
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(result.stdout).toBe('no-input');
    expect(result.stderr).toBe('AUTH_DONE\n');
    expect(JSON.stringify(result)).not.toContain('late-synthetic-secret');
  });

  it('routes an askpass answer only to its isolated helper stdout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cloudhelm-auth-test-')); temporary.push(root);
    const directory = `${root}/channel`;
    const paths: InputPaths = { directory, secret: `${directory}/secret`, prompt: `${directory}/prompt`, normal: `${directory}/normal`, askpass: `${directory}/askpass` };
    const setup = await shell(setupInput(paths, 'AUTH_REQUEST'));
    expect(setup, setup.stderr).toMatchObject({ code: 0 });
    // Pair each blocking read-only FIFO open with the helper's write-only open,
    // then pair the answer writer with its reader. O_RDWR FIFO opens have undefined
    // POSIX semantics. Keep blocking I/O out of libuv's shared worker pool.
    const reply = `${root}/reply`;
    // Use the helper's declared interpreter; this test checks its channel isolation,
    // independent of macOS execution policy for newly generated executable files.
    const script = `/bin/sh ${quoteShell(paths.askpass)} > ${quoteShell(reply)} & helper=$!; `
      + `IFS= read -r prompt < ${quoteShell(paths.prompt)}; printf '%s\\n' "$prompt"; `
      + `printf '%s\\n' 'synthetic-password' > ${quoteShell(paths.secret)}; wait "$helper"; cat ${quoteShell(reply)}`;
    const result = await shell(script);
    expect(result).toEqual({ stdout: 'AUTH_REQUEST\nsynthetic-password\n', stderr: '', code: 0 });
    expect(await readFile(paths.askpass, 'utf8')).not.toContain('synthetic-password');
  });

  it('closes inherited output pipes when a helper process group times out', async () => {
    await expect(shell('sleep 30 & wait', '', 100)).rejects.toThrow('process group timed out');
  });
});
