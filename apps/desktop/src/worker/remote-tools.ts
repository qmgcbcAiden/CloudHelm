import { createHash, randomUUID } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { SafetyGate } from '@cloudhelm/application';
import type { OperationScope, ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { LocalFileAccess } from './local-file-access.js';

interface Dependencies {
  hosts: RuntimeHost[];
  localFiles: LocalFileAccess;
  ensureTerminal(hostId: string): Promise<string>;
  scope(host: RuntimeHost, terminalId: string, cwd?: string): OperationScope;
  runOperation(gate: SafetyGate, operation: ProposedOperation, signal: AbortSignal | undefined, hostLabel: string): Promise<{ content: Array<{ type: 'text'; text: string }>; details: undefined; isError: boolean }>;
}
function outOfScope() {
  return { content: [{ type: 'text' as const, text: 'Host is outside the conversation authorization scope' }], details: undefined, isError: true };
}
export function createRemoteTools(deps: Dependencies, gate: SafetyGate) {
    const parameters = Type.Object({ hostId: Type.String(), command: Type.String(), cwd: Type.Optional(Type.String()) });
    const tool: AgentTool<typeof parameters> = {
      name: 'run_remote', label: 'Execute an audited remote SSH command',
      description: 'Run a complete shell command on a selected authorized host. Commands are shown in its dedicated real SSH terminal after safety review. Use absolute paths when possible.',
      parameters,
      replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        const terminalId = await deps.ensureTerminal(host.id);
        const operation: ProposedOperation = { id: randomUUID(), kind: 'command', command: params.command,
          scope: deps.scope(host, terminalId, params.cwd) };
        return deps.runOperation(gate, operation, signal, host.label);
      }
    };
    const writeParameters = Type.Object({ hostId: Type.String(), path: Type.String(), content: Type.String(), cwd: Type.Optional(Type.String()) });
    const writeTool: AgentTool<typeof writeParameters> = {
      name: 'write_remote_file', label: 'Write an audited remote file',
      description: 'Write a UTF-8 file over SFTP on an authorized host. Existing regular files receive a private recovery copy. Maximum 1 MiB. Parent directory must exist.',
      parameters: writeParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        const terminalId = await deps.ensureTerminal(host.id);
        return deps.runOperation(gate, { id: randomUUID(), kind: 'write-file', path: params.path, content: params.content,
          scope: deps.scope(host, terminalId, params.cwd) }, signal, host.label);
      }
    };
    const deleteParameters = Type.Object({ hostId: Type.String(), path: Type.String(), cwd: Type.Optional(Type.String()) });
    const deleteTool: AgentTool<typeof deleteParameters> = {
      name: 'delete_remote_file', label: 'Delete an audited remote file',
      description: 'Delete only a regular file on an authorized host, retaining a private recovery copy. Directories and symlinks are refused.',
      parameters: deleteParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        const terminalId = await deps.ensureTerminal(host.id);
        return deps.runOperation(gate, { id: randomUUID(), kind: 'delete-path', path: params.path,
          scope: deps.scope(host, terminalId, params.cwd) }, signal, host.label);
      }
    };
    const listLocalParameters = Type.Object({ path: Type.String() });
    const listLocalTool: AgentTool<typeof listLocalParameters> = {
      name: 'list_selected_directory', label: 'List a selected local directory',
      description: 'List at most 200 entries inside a directory explicitly selected by the user. Use absolute paths.',
      parameters: listLocalParameters, replay: 'never',
      execute: async (_id, params) => {
        try { return { content: [{ type: 'text', text: JSON.stringify(await deps.localFiles.list(params.path)) }], details: undefined }; }
        catch (error) { return { content: [{ type: 'text', text: String(error) }], details: undefined, isError: true }; }
      }
    };
    const readLocalParameters = Type.Object({ path: Type.String() });
    const readLocalTool: AgentTool<typeof readLocalParameters> = {
      name: 'read_selected_text_file', label: 'Read a selected local text file',
      description: 'Read UTF-8 text from a file explicitly selected by the user, or inside a selected directory. Files above 128 KiB need another approach.',
      parameters: readLocalParameters, replay: 'never',
      execute: async (_id, params) => {
        try {
          const { data } = await deps.localFiles.read(params.path);
          if (data.length > 131_072 || data.includes(0)) throw new Error('This file is binary or too large for model text context');
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
          return { content: [{ type: 'text', text: decoded }], details: undefined };
        } catch (error) { return { content: [{ type: 'text', text: String(error) }], details: undefined, isError: true }; }
      }
    };
    const uploadParameters = Type.Object({ hostId: Type.String(), localPath: Type.String(), remotePath: Type.String(), cwd: Type.Optional(Type.String()) });
    const uploadTool: AgentTool<typeof uploadParameters> = {
      name: 'upload_selected_file', label: 'Upload an audited selected file',
      description: 'Upload a regular file of at most 1 MiB from a user-selected local source to an authorized SSH host. Changes require safety review.',
      parameters: uploadParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        const terminalId = await deps.ensureTerminal(host.id);
        try {
          const { data, scope } = await deps.localFiles.read(params.localPath);
          return deps.runOperation(gate, { id: randomUUID(), kind: 'upload', localPath: params.localPath,
            localRoot: scope.path, remotePath: params.remotePath, size: data.length,
            contentSha256: createHash('sha256').update(data).digest('hex'),
            scope: deps.scope(host, terminalId, params.cwd) }, signal, host.label);
        } catch (error) { return { content: [{ type: 'text' as const, text: String(error) }], details: undefined, isError: true }; }
      }
    };
  return [tool, writeTool, deleteTool, listLocalTool, readLocalTool, uploadTool];
}
