import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { RuntimeResourceView } from '@cloudhelm/contracts';
import { commitRuntimeResource, markRuntimeResourcesUnknown } from '../../../apps/desktop/src/main/runtime-resource-journal.js';
const record: RuntimeResourceView = { id: 'resource', taskId: 'task', hostId: 'host', terminalId: 'terminal',
  terminalGeneration: 1, generation: 1, loginAs: 'deploy', runAs: 'deploy', revision: 1, state: 'prepared', updatedAt: 1,
  plan: { version: 1, action: 'install', directory: '/tmp/cloudhelm-run-fixture', executable: '/tmp/cloudhelm-run-fixture/helper',
    sessionId: 'session', purpose: 'execute', parentOperationId: 'operation',
    artifact: { protocolVersion: 1, platform: 'linux', arch: 'amd64', sha256: 'a'.repeat(64), size: 7 } } };

describe('durable runtime resource compare-and-swap transitions', () => {
  it('requires the expected revision and immutable ownership through confirmed cleanup', () => {
    const store = new SqliteStore(':memory:');
    try {
      commitRuntimeResource(store, record); commitRuntimeResource(store, record);
      const ready = { ...record, state: 'ready' as const, revision: 2 };
      commitRuntimeResource(store, ready);
      expect(() => commitRuntimeResource(store, { ...ready, state: 'cleaning' })).toThrow('stale');
      expect(() => commitRuntimeResource(store, { ...ready, taskId: 'foreign', state: 'cleaning', revision: 3 })).toThrow('binding');
      const cleaning = { ...ready, state: 'cleaning' as const, revision: 3 }; commitRuntimeResource(store, cleaning);
      const closed = { ...cleaning, state: 'closed' as const, revision: 4 }; commitRuntimeResource(store, closed);
      expect(() => commitRuntimeResource(store, { ...closed, state: 'ready', revision: 5 })).toThrow('invalid');
      expect(store.get('runtime-resources', record.id)).toEqual(closed);
    } finally { store.close(); }
  });
  it('projects resources as unknown after worker loss and rejects delayed success acknowledgments', () => {
    const store = new SqliteStore(':memory:');
    try {
      commitRuntimeResource(store, record); markRuntimeResourcesUnknown(store);
      expect(store.get('runtime-resources', record.id)).toMatchObject({ state: 'unknown', revision: 2 });
      expect(() => commitRuntimeResource(store, { ...record, state: 'ready', revision: 2 })).toThrow();
      markRuntimeResourcesUnknown(store);
      expect(store.get('runtime-resources', record.id)).toMatchObject({ state: 'unknown', revision: 2 });
    } finally { store.close(); }
  });
});
