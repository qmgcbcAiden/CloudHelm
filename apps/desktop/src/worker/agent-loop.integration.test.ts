import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HostKeyError } from '@cloudhelm/adapters';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeMessage, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import { WorkerServer } from './server.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

const run = process.env.CLOUDHELM_TEST_SSH_KEY ? it : it.skip;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe('Pi agent loop over a real loopback SSH session', () => {
  run('investigates, independently audits an SFTP write, verifies the result, and switches models only at the next request', async () => {
    const root = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'cloudhelm-agent-loop-'));
    const file = path.join(root, 'service-fixture.txt');
    const expectedContent = 'CloudHelm end-to-end fixture: healthy\n';
    const events: RuntimeMessage[] = [];
    const operationSnapshots = new Map<string, OperationView>();
    let releaseSecondRequest!: () => void;
    const secondRequestHold = new Promise<void>((resolve) => { releaseSecondRequest = resolve; });
    let mainRequestCount = 0;
    const fixture = await openAiFixture(async (request) => {
      if (request.review) return { text: 'ALLOW' };
      mainRequestCount++;
      switch (mainRequestCount) {
        case 1: return { calls: [
          { id: 'plan', name: 'update_plan', arguments: { steps: [
            { id: 'inspect', title: '检查临时服务目录', status: 'running' },
            { id: 'write', title: '写入服务配置并读回验证', status: 'pending' }
          ] } },
          { id: 'inspect', name: 'run_remote', arguments: { hostId: 'local-fixture', command: 'pwd', cwd: root } }
        ] };
        case 2:
          await secondRequestHold;
          return { calls: [{ id: 'write', name: 'write_remote_file', arguments: {
            hostId: 'local-fixture', path: file, content: expectedContent, cwd: root
          } }] };
        case 3: return { calls: [{ id: 'verify', name: 'run_remote', arguments: {
          hostId: 'local-fixture', command: `cat ${shellQuote(file)}`, cwd: root
        } }] };
        case 4: {
          const output = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'verify');
          const text = output ? fixtureMessageText(output) : '';
          const evidenceId = /Operation ID: ([^\n]+)/u.exec(text)?.[1];
          if (!evidenceId || !text.includes(expectedContent.trim())) throw new Error('Pi did not receive successful SSH verification output');
          return { calls: [{ id: 'report', name: 'submit_verification', arguments: {
            summary: '临时服务配置已写入，并通过真实 SSH 读回验证。', access: [`本机临时文件 ${file}`],
            evidenceOperationIds: [evidenceId], changes: [`创建 ${file}`], recovery: ['测试结束后仅清理专用临时目录']
          } }] };
        }
        case 5: return { text: '配置已写入并验证，结果等待验收。' };
        default: throw new Error(`Unexpected autonomous request ${mainRequestCount}`);
      }
    });
    const server = new WorkerServer((message) => {
      events.push(structuredClone(message));
      if ('event' in message && message.event.type === 'operation') operationSnapshots.set(message.event.value.id, structuredClone(message.event.value));
      if ('readLog' in message) server.resolveLog({ id: message.readLog.id, value: { text: '', nextCursor: 0, more: false } });
    });
    const host: RuntimeHost = {
      id: 'local-fixture', label: 'Temporary loopback SSH fixture', address: '127.0.0.1',
      port: Number(process.env.CLOUDHELM_TEST_SSH_PORT ?? '22388'),
      username: process.env.CLOUDHELM_TEST_SSH_USER ?? process.env.USER ?? '',
      auth: 'private-key', privateKeyPath: process.env.CLOUDHELM_TEST_SSH_KEY,
      status: 'disconnected', defaultMode: 'ai-review', protectedPaths: [], policyRevision: 1
    };
    const profile = (modelId: string, apiKey: string): RuntimeProfile => ({
      provider: 'cloudhelm-custom', modelId, apiKey, baseUrl: fixture.baseUrl
    });
    const task: TaskView = {
      id: 'loopback-conversation', goal: `Inspect ${root}, write ${file}, and read it back to verify the content.`,
      hostIds: [host.id], localScopes: [], status: 'draft', modelId: 'fixture-a', provider: 'cloudhelm-custom',
      requestCount: 0, requestLimit: 10, createdAt: Date.now(), updatedAt: Date.now()
    };
    try {
      try { await server.dispatch({ method: 'connect', host }); }
      catch (error) {
        if (!(error instanceof HostKeyError)) throw error;
        host.fingerprint = error.fingerprint;
        await server.dispatch({ method: 'connect', host });
      }
      await server.dispatch({ method: 'start-task', task, hosts: [host], profile: profile('fixture-a', 'dummy-key-a') });
      await vi.waitFor(() => {
        expect(fixture.errors).toEqual([]);
        expect(mainRequestCount).toBe(2);
      }, { timeout: 15_000 });

      // Request two is still in flight. Its eventual write and independent audit belong to A.
      await server.dispatch({ method: 'set-conversation-model', taskId: task.id, profile: profile('fixture-b', 'dummy-key-b') });
      expect(fixture.requests.filter((request) => !request.review).map((request) => request.model)).toEqual(['fixture-a', 'fixture-a']);
      releaseSecondRequest();
      await vi.waitFor(() => {
        expect(fixture.errors).toEqual([]);
        const statuses = events.flatMap((message) => 'event' in message && message.event.type === 'task-status' ? [message.event] : []);
        expect(statuses.at(-1)?.status, JSON.stringify(statuses.at(-1))).toBe('ready-for-review');
      }, { timeout: 20_000 });

      expect(await readFile(file, 'utf8')).toBe(expectedContent);
      const mainRequests = fixture.requests.filter((request) => !request.review);
      expect(mainRequests.map((request) => request.model)).toEqual(['fixture-a', 'fixture-a', 'fixture-b', 'fixture-b', 'fixture-b']);
      expect(mainRequests.map((request) => request.authorization)).toEqual([
        'Bearer dummy-key-a', 'Bearer dummy-key-a', 'Bearer dummy-key-b', 'Bearer dummy-key-b', 'Bearer dummy-key-b'
      ]);
      const reviews = fixture.requests.filter((request) => request.review);
      // Literal-path cat is low-risk; only the SFTP write needs independent review.
      expect(reviews.map((request) => request.model)).toEqual(['fixture-a']);
      expect(reviews[0]).toMatchObject({ model: 'fixture-a', authorization: 'Bearer dummy-key-a' });
      expect(reviews.every((request) => !request.messages.some((message) => message.role === 'tool'))).toBe(true);
      expect(JSON.stringify(reviews[0]?.messages)).toContain('write-file');
      expect(JSON.stringify(reviews[0]?.messages)).toContain(file);
      expect(events.some((message) => 'event' in message && message.event.type === 'approval-open')).toBe(false);

      const operations = [...operationSnapshots.values()];
      expect(operations.map((operation) => operation.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
      expect(operations.map((operation) => operation.model?.modelId)).toEqual(['fixture-a', 'fixture-a', 'fixture-b']);
      expect(operations.find((operation) => operation.kind === 'write-file')?.reason).toContain('Wrote');
      const output = events.flatMap((message) => 'event' in message && message.event.type === 'terminal-data' ? [message.event.data] : []).join('');
      expect(output).toContain('pwd');
      expect(output).toContain(expectedContent.trim());
      expect(events.some((message) => 'event' in message && message.event.type === 'work-report'
        && message.event.report?.evidenceOperationIds.length === 1)).toBe(true);
      expect(events.some((message) => 'event' in message && message.event.type === 'task-status' && message.event.status === 'accepted')).toBe(false);
      expect(JSON.stringify(events)).not.toContain('dummy-key-');
    } finally {
      releaseSecondRequest();
      await server.dispatch({ method: 'disconnect', hostId: host.id });
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
