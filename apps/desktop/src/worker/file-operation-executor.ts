import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SshTransport } from '@cloudhelm/adapters';
import { operationFingerprint, type ExecutionOptions, type OperationExecutor, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import type { TerminalManager } from '@cloudhelm/application';
import { LocalFileAccess } from './local-file-access.js';

/** Executes reviewed structured writes over SFTP without exposing arbitrary SFTP access to the renderer. */
export class FileOperationExecutor implements OperationExecutor {
  constructor(private readonly terminal: TerminalManager, private readonly ssh: SshTransport,
    private readonly commands: OperationExecutor) {}

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (operation.kind === 'command') return this.commands.execute(operation, fingerprint, signal, options);
    const connectionGeneration = this.ssh.connectionGeneration(operation.scope.hostId);
    const assertAuthorized = () => {
      if (operationFingerprint(operation) !== fingerprint || signal?.aborted || options?.isAuthorized?.() === false
      || this.ssh.connectionGeneration(operation.scope.hostId) !== connectionGeneration
      || !this.terminal.isAgentOwner(operation.scope.terminalId)
      || this.terminal.currentGeneration(operation.scope.terminalId) !== operation.scope.terminalGeneration
      || this.terminal.hostOf(operation.scope.terminalId) !== operation.scope.hostId
      || this.terminal.taskOf(operation.scope.terminalId) !== operation.scope.taskId) {
        throw new Error('Structured file operation authorization expired');
      }
    };
    assertAuthorized();
    const remotePath = path.posix.resolve(operation.scope.cwd,
      operation.kind === 'upload' ? operation.remotePath : operation.path);
    let remoteStarted = false;
    try {
      let content: Buffer | undefined;
      if (operation.kind === 'upload') {
        content = (await new LocalFileAccess([{ path: operation.localRoot, kind: 'directory' }]).read(operation.localPath)).data;
        if (content.length !== operation.size || createHash('sha256').update(content).digest('hex') !== operation.contentSha256) {
          return { operationId: operation.id, status: 'failed', stdoutTail: 'Selected local file changed after review; propose it again' };
        }
      }
      assertAuthorized();
      remoteStarted = true;
      const backup = operation.kind === 'delete-path'
        ? await this.ssh.deleteFile(operation.scope.hostId, remotePath, assertAuthorized)
        : await this.ssh.writeFile(operation.scope.hostId, remotePath,
          operation.kind === 'write-file' ? Buffer.from(operation.content) : content!, assertAuthorized);
      const handover = !this.terminal.isAgentOwner(operation.scope.terminalId)
        || this.terminal.currentGeneration(operation.scope.terminalId) !== operation.scope.terminalGeneration;
      return {
        operationId: operation.id, status: handover ? 'handed-over' : 'succeeded', exitCode: 0,
        stdoutTail: `${operation.kind === 'delete-path' ? 'Deleted' : 'Wrote'} ${remotePath}.`
          + (backup ? ` Recovery copy: ${backup}` : ' New file; no previous version.'),
        logRef: operation.scope.terminalId
      };
    } catch (error) {
      return { operationId: operation.id, status: remoteStarted ? 'unknown' : 'failed',
        stdoutTail: `SFTP operation needs verification: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
