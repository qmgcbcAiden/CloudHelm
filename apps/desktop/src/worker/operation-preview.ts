import { createHash } from 'node:crypto';
import { redactOutput, type ProposedOperation } from '@cloudhelm/core';

export function operationPreview(operation: ProposedOperation): string {
    if (operation.kind === 'command') return redactOutput(operation.command);
    if (operation.kind === 'runtime') return `运行组件 ${operation.runtime.action} · ${operation.runtime.executable} · SHA-256 ${operation.runtime.artifact.sha256}`;
    if (operation.kind === 'write-file') return `写入文件 ${operation.path} · ${Buffer.byteLength(operation.content)} 字节 · SHA-256 ${createHash('sha256').update(operation.content).digest('hex')}`;
    if (operation.kind === 'delete-path') return `删除文件 ${operation.path}`;
    return `上传 ${operation.localPath} → ${operation.remotePath}`;
  }

