import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HostKeyError, SshTransport, type SshHost } from '@cloudhelm/adapters';
import { InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, type ProposedOperation, type RawTerminal } from '@cloudhelm/core';
import { OperationInputBridge } from './operation-input-bridge.js';

const run = process.env.CLOUDHELM_TEST_SSH_KEY ? it : it.skip;

describe('real SSH PTY and operation input', () => {
  run('shows actual command output, answers bounded apt confirmation through FIFO, and hands over without stopping the command', async () => {
    const ssh = new SshTransport();
    const root = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'cloudhelm-pty-'));
    const host: SshHost = {
      id: 'host', label: 'Local SSH test', address: '127.0.0.1',
      port: Number(process.env.CLOUDHELM_TEST_SSH_PORT ?? '22388'),
      username: process.env.CLOUDHELM_TEST_SSH_USER ?? process.env.USER ?? '',
      auth: 'private-key', privateKeyPath: process.env.CLOUDHELM_TEST_SSH_KEY
    };
    try {
      try { await ssh.connect(host, {}); }
      catch (error) {
        if (!(error instanceof HostKeyError)) throw error;
        host.fingerprint = error.fingerprint;
      }
      await ssh.connect(host, {});
      const apt = path.join(root, 'apt');
      await writeFile(apt, '#!/bin/sh\nprintf "0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.\\nDo you want to continue? [Y/n] "\nIFS= read -r answer\nprintf "\\nanswer=%s\\n" "$answer"\n');
      await chmod(apt, 0o700);
      const channel = await ssh.shell(host.id);
      const observed: string[] = [];
      const raw: RawTerminal = {
        // The fixture supplies a harmless fake apt; production uses a fixed, clean PATH.
        write: (data) => channel.write(data.replace('PATH=/usr/local/sbin:', `PATH='${root}':/usr/local/sbin:`)), resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
        close: () => channel.end(), onData: (listener) => channel.on('data', (data: Buffer) => listener(data.toString('utf8'))),
        onClose: (listener) => channel.on('close', listener)
      };
      const terminal = new TerminalManager({ data: (_id, data) => observed.push(data), state() {} });
      const terminalId = terminal.open(host.id, raw, 'task');
      const scope = {
        taskId: 'task', hostId: host.id, cwd: root, runAs: host.username, terminalId,
        terminalGeneration: terminal.currentGeneration(terminalId), policyRevision: 1,
        allowedWorkingRoots: [root], protectedPaths: [], goal: 'Install test package'
      };
      const first: ProposedOperation = { id: 'first', kind: 'command', command: 'printf cloudhelm-command-ok', scope };
      expect((await terminal.execute(first, operationFingerprint(first))).status).toBe('succeeded');
      expect(observed.join('')).toContain('cloudhelm-command-ok');

      const auto = vi.fn();
      const requests: string[] = [];
      const interactions = new InteractionCoordinator(terminal, {
        opened: (request) => requests.push(request.id), closed() {}
      });
      const bridge = new OperationInputBridge(terminal, ssh, interactions, auto);
      const install: ProposedOperation = { id: 'install', kind: 'command', command: 'apt install example', scope };
      const result = await bridge.execute(install, operationFingerprint(install));
      expect(result.status).toBe('succeeded');
      expect(observed.join('')).toContain('answer=y');
      expect(auto).toHaveBeenCalledOnce();
      expect(requests).toEqual([]);

      const pending: ProposedOperation = { id: 'pending', kind: 'command', command: 'sleep 1', scope };
      const running = terminal.execute(pending, operationFingerprint(pending));
      terminal.takeOver(terminalId);
      expect((await running).status).toBe('handed-over');
      channel.end();
    } finally {
      ssh.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
