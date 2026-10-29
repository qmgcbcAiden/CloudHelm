import path from 'node:path';
import type { OperationScope } from './model.js';
const sensitive = /(?:^\/etc\/(?:shadow|gshadow)$|\/\.ssh\/(?:id_[^/]+|authorized_keys)$|(?:^|\/)\.env(?:\.[^/]+)?$)/u;
const inside = (target: string, root: string) => target === path.posix.resolve(root)
  || target.startsWith(`${path.posix.resolve(root).replace(/\/$/u, '')}/`);
/** Covers both user content and the recovery metadata actually read by the helper. */
export function fileReadProtectionReason(target: string, scope: OperationScope, transactionId?: string): string | undefined {
  const absolute = path.posix.resolve(scope.cwd, target);
  if (sensitive.test(absolute)) return 'Credential file contents cannot enter managed snapshots';
  const targets = [absolute];
  if (transactionId) targets.push(path.posix.join(path.posix.dirname(absolute), `.cloudhelm-txn-${transactionId}`, 'manifest.json'));
  if (targets.some((value) => (scope.protectedReadPaths ?? scope.protectedPaths).some((root) => inside(value, root)))) {
    return 'Current read protection forbids file content or its transaction metadata';
  }
  return undefined;
}
