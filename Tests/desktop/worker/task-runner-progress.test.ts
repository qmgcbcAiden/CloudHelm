import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { TaskView } from '@cloudhelm/contracts';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

it.each(['new-pages', 'same-page', 'plans'] as const)('uses real observation progress for %s', async (mode) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloudhelm-progress-'))); const file = join(root, 'selected.txt');
  await writeFile(file, Array.from({ length: 20 }, (_, index) => `Observed line ${index + 1}`).join('\n'));
  let count = 0;
  const fixture = await openAiFixture(async () => {
    count++;
    if (mode === 'new-pages' && count === 13) return { text: '已读到12页不同资料。' };
    return { calls: [{ id: `new-call-${count}`, name: mode === 'plans' ? 'update_plan' : 'read_selected_text_file',
      arguments: mode === 'plans' ? { steps: [{ id: `step-${count}`, title: `Reworded plan ${count}`, status: 'pending' }] }
        : { path: file, offset: mode === 'new-pages' ? count : 1, limit: 1 } }] };
  });
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const task: TaskView = { id: 'progress-task', goal: '阅读已选资料', hostIds: [], localScopes: [{ path: file, kind: 'file' }],
    modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 30, createdAt: 1, updatedAt: 1 };
  const execute = vi.fn(async () => { throw new Error('Remote execution forbidden in this fixture'); });
  const runner = new TaskRunner(task, [], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl }, [],
    new TerminalManager({ data() {}, state() {} }), { execute }, async () => { throw new Error('SSH forbidden'); },
    { event: (event) => events.push(event), requestApproval: async () => false, cancelApproval() {} });
  try {
    await runner.start();
    expect(fixture.errors).toEqual([]);
    expect(count).toBe(mode === 'new-pages' ? 13 : mode === 'same-page' ? 11 : 10);
    expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: mode === 'new-pages' ? 'answered' : 'paused' });
    expect(execute).not.toHaveBeenCalled();
  } finally { runner.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
