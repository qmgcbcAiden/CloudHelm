import { expect, it } from 'vitest';
import { operationIntentKey, type ProposedOperation } from '@cloudhelm/core';

const scope = { taskId: 'task', hostId: 'host', terminalId: 'terminal', terminalGeneration: 1, policyRevision: 1,
  runAs: 'user', loginAs: 'user', cwd: '/srv', allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'configure service' };

// Recorded by executing the unmodified fingerprint implementation at 34d8ce8.
// A migration must retain these replay barriers without rewriting history or grants.
it.each<[ProposedOperation, string]>([
  [{ id: 'op', scope, kind: 'command', command: 'sudo -u deploy id' }, 'c1490e6220789dfffcc2ff493eef041a444f39e06164603536df8aa03c625987'],
  [{ id: 'op', scope, kind: 'write-file', path: '/srv/a', content: 'new' }, '413335106df23f55143e904cd829fe37872f8fe3f6d8c415d9542318dcdac7b9'],
  [{ id: 'op', scope, kind: 'upload', localPath: '/local/a', remotePath: '/srv/a', localRoot: '/local', contentSha256: 'a'.repeat(64), size: 3 },
    'bdbcea12cf3f80f93243aead52ee4a077620811eeaafb6a2d50e649f6d361f38'],
  [{ id: 'op', scope, kind: 'delete-path', path: '/srv/a' }, 'bd4011c7befe7ebfbd4896cd90ca24f0d28aa3f007b517aa02523956fa96f1f9']
])('preserves v11 intent identity for %o', (operation, expected) => {
  expect(operationIntentKey(operation)).toBe(expected);
  expect(operationIntentKey({ ...operation, scope: { ...scope, sudoCachePolicy: { mode: 'single-password-auto', revision: 5 } } })).toBe(expected);
});
