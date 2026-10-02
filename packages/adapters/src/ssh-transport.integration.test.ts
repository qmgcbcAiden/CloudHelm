import { describe, expect, it } from 'vitest';
import { HostKeyError, SshTransport, type SshHost } from './ssh-transport.js';

const testKey = process.env.CLOUDHELM_TEST_SSH_KEY;
const run = testKey ? it : it.skip;

describe('SSH transport against an opt-in local SSH server', () => {
  run('verifies the host key, opens a real PTY and preserves SFTP recovery copies', async () => {
    const transport = new SshTransport();
    const host: SshHost = {
      id: 'smoke-host', label: 'Local test server', address: '127.0.0.1',
      port: Number(process.env.CLOUDHELM_TEST_SSH_PORT ?? '22388'),
      username: process.env.CLOUDHELM_TEST_SSH_USER ?? process.env.USER ?? '',
      auth: 'private-key', privateKeyPath: testKey
    };
    try {
      let fingerprint = '';
      try { await transport.connect(host, {}); }
      catch (error) {
        expect(error).toBeInstanceOf(HostKeyError);
        fingerprint = (error as HostKeyError).fingerprint;
      }
      expect(fingerprint).toMatch(/^SHA256:/u);
      host.fingerprint = fingerprint;
      await transport.connect(host, {});

      const shell = await transport.shell(host.id);
      const output = new Promise<string>((resolve, reject) => {
        let buffer = '';
        const timeout = setTimeout(() => reject(new Error('PTY did not echo the executed command')), 5000);
        shell.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          if (buffer.includes('cloudhelm-pty-ok')) { clearTimeout(timeout); resolve(buffer); }
        });
      });
      shell.write("printf 'cloudhelm-pty-ok\\n'\n");
      expect(await output).toContain('cloudhelm-pty-ok');
      shell.end();

      const remoteRoot = process.env.CLOUDHELM_TEST_REMOTE_ROOT ?? (process.platform === 'darwin' ? '/private/tmp' : '/tmp');
      const remote = `${remoteRoot}/cloudhelm-transport-${Date.now()}`;
      expect(await transport.writeFile(host.id, remote, Buffer.from('first'))).toBeUndefined();
      const backup = await transport.writeFile(host.id, remote, Buffer.from('second'));
      expect(backup).toContain('.cloudhelm-backup-');
      expect((await transport.execFixed(host.id, `cat '${remote}'`)).output).toContain('second');
      expect((await transport.execFixed(host.id, `cat '${backup}'`)).output).toContain('first');
      const deletedBackup = await transport.deleteFile(host.id, remote);
      expect((await transport.execFixed(host.id, `cat '${deletedBackup}'`)).output).toContain('second');
      await transport.execFixed(host.id, `rm -f -- '${backup}' '${deletedBackup}'`);
    } finally { transport.close(); }
  }, 20_000);
});
