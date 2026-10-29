import { Value } from 'typebox/value';
import { RuntimeResourceSchema, type RuntimeResourceView } from '@cloudhelm/contracts';
import type { SqliteStore } from '@cloudhelm/adapters';
export function commitRuntimeResource(store: SqliteStore, value: unknown): void {
  if (!Value.Check(RuntimeResourceSchema, value)) throw new Error('Invalid runtime resource');
  const record = value as RuntimeResourceView;
  const prior = store.get<RuntimeResourceView>('runtime-resources', record.id);
  if (prior && JSON.stringify(prior) === JSON.stringify(record)) return;
  if (prior && (prior.taskId !== record.taskId || prior.hostId !== record.hostId || prior.generation !== record.generation
    || prior.terminalId !== record.terminalId || prior.terminalGeneration !== record.terminalGeneration
    || prior.loginAs !== record.loginAs || prior.runAs !== record.runAs
    || JSON.stringify(prior.plan) !== JSON.stringify(record.plan))) throw new Error('Runtime resource binding changed');
  if (!prior && (record.state !== 'prepared' || record.revision !== 1)) throw new Error('Runtime intent is required');
  if (prior && (record.revision !== prior.revision + 1 || !({
    prepared: ['ready', 'unknown'], ready: ['cleaning', 'unknown'], cleaning: ['closed', 'unknown'], unknown: [], closed: []
  } as Record<string, string[]>)[prior.state]?.includes(record.state))) throw new Error('Runtime resource transition is stale or invalid');
  store.put('runtime-resources', record.id, record);
}

/** A lost worker cannot prove its last installation/cleanup completed. Never replay on startup. */
export function markRuntimeResourcesUnknown(store: SqliteStore): void {
  for (const record of store.list<RuntimeResourceView>('runtime-resources')) {
    if (['closed', 'unknown'].includes(record.state)) continue;
    commitRuntimeResource(store, { ...record, state: 'unknown', revision: record.revision + 1, updatedAt: Date.now() });
  }
}
