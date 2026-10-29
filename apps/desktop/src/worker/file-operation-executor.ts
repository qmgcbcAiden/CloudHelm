import { operationFingerprint, type ExecutionOptions, type FileTransactionJournal, type FileTransactionRecord,
  type OperationExecutor, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import { fileContentHash, loadFileOperationContent, type FileRemotePort, type ManagedFileOperation, type RemoteFileResult,
  type TerminalManager } from '@cloudhelm/application';
import type { SshTransport } from '@cloudhelm/adapters';
import { LocalFileAccess } from './local-file-access.js';

export interface FileExecutionDependencies { remote: FileRemotePort; journal: FileTransactionJournal }
export type FileExecutionFactory = (operation: ManagedFileOperation) => FileExecutionDependencies | Promise<FileExecutionDependencies>;
/** Reviewed native transactions preserve the file identity, metadata and durable receipt. */
export class FileOperationExecutor implements OperationExecutor {
  constructor(private readonly terminal: TerminalManager, private readonly ssh: SshTransport,
    private readonly commands: OperationExecutor, private readonly files?: FileExecutionFactory) {}
  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (operation.kind === 'command' || operation.kind === 'runtime') return this.commands.execute(operation, fingerprint, signal, options);
    const generation = this.ssh.connectionGeneration(operation.scope.hostId);
    const assertAuthorized = () => {
      if (operationFingerprint(operation) !== fingerprint || signal?.aborted || options?.isAuthorized?.() === false
        || this.ssh.connectionGeneration(operation.scope.hostId) !== generation || !this.terminal.isAgentOwner(operation.scope.terminalId)
        || this.terminal.currentGeneration(operation.scope.terminalId) !== operation.scope.terminalGeneration
        || this.terminal.hostOf(operation.scope.terminalId) !== operation.scope.hostId || this.terminal.taskOf(operation.scope.terminalId) !== operation.scope.taskId) throw new Error('File operation authorization expired');
    };
    let dispatched = false; let journal: FileTransactionJournal | undefined; let record: FileTransactionRecord | undefined;
    try {
      assertAuthorized();
      if (!this.files || !operation.filePlan) return { operationId: operation.id, status: 'failed', effects: 'none', failureKind: 'unsupported', stdoutTail: 'Native file transaction preparation is required; no file was changed.' };
      const deps = await this.files(operation); journal = deps.journal;
      const content = await loadFileOperationContent(operation, async (upload, abort) =>
        (await new LocalFileAccess([{ path: upload.localRoot, kind: 'directory' }]).read(upload.localPath, abort)).data, signal);
      if ((content ? fileContentHash(content) : undefined) !== operation.filePlan.contentSha256 || (content?.length ?? 0) !== operation.filePlan.contentSize) throw new Error('File content differs from the reviewed plan');
      assertAuthorized();
      const existing = await journal.get(operation.filePlan.transactionId, signal);
      if (existing) return { operationId: operation.id, status: 'unknown', effects: 'possible', stdoutTail: 'A file transaction already exists. Recover its receipt; do not replay the write.' };
      record = await journal.commit({ id: operation.filePlan.transactionId, operationId: operation.id, taskId: operation.scope.taskId,
        hostId: operation.scope.hostId, fingerprint, loginAs: operation.scope.loginAs ?? operation.scope.runAs, runAs: operation.scope.runAs,
        plan: structuredClone(operation.filePlan), stage: 'prepared', revision: 1, updatedAt: Date.now() }, null, signal);
      assertAuthorized(); dispatched = true;
      const remoteResult = await deps.remote.apply(operation, fingerprint, content, signal, assertAuthorized, async (staged) => {
        record = await journal!.commit({ ...record!, stage: 'staged', directory: staged.directory, backup: staged.backup,
          revision: record!.revision + 1, updatedAt: Date.now() }, record!.revision, signal);
        assertAuthorized();
      });
      record = await journal.commit({ ...record, stage: remoteResult.stage ?? 'unknown', directory: remoteResult.directory,
        backup: remoteResult.backup, receipt: remoteResult.receipt, revision: record.revision + 1, updatedAt: Date.now() }, record.revision, signal);
      return this.result(operation, remoteResult);
    } catch (error) {
      if (dispatched && journal && record) {
        try { await journal.commit({ ...record, stage: 'unknown', revision: record.revision + 1, updatedAt: Date.now() }, record.revision); } catch { /* Keep the last durable stage; never invent a receipt. */ }
      }
      return { operationId: operation.id, status: dispatched ? 'unknown' : 'failed', effects: dispatched ? 'possible' : 'none',
        stdoutTail: dispatched ? 'File transaction needs recovery before further writes.' : `File operation not dispatched: ${error instanceof Error ? error.message : 'preparation failed'}` };
    }
  }
  private result(operation: ManagedFileOperation, result: RemoteFileResult): OperationResult {
    const handover = !this.terminal.isAgentOwner(operation.scope.terminalId)
      || this.terminal.currentGeneration(operation.scope.terminalId) !== operation.scope.terminalGeneration;
    return { operationId: operation.id, status: handover ? 'handed-over' : result.status === 'succeeded' ? 'succeeded' : result.status === 'failed' ? 'failed' : 'unknown',
      effects: result.effects, exitCode: result.status === 'succeeded' ? 0 : undefined,
      failureKind: result.code === 'permission-denied' ? 'permission-denied' : result.code === 'unsupported' ? 'unsupported' : undefined,
      stdoutTail: result.status === 'succeeded' ? `File transaction committed and verified: ${operation.filePlan!.before.path}.${result.backup ? ` Recovery copy: ${result.backup}` : ''}`
        : `File transaction ${result.code ?? result.status}; ${result.effects === 'none' ? 'target unchanged' : 'verify the recorded transaction before continuing'}.`,
      logRef: operation.scope.terminalId };
  }
}
