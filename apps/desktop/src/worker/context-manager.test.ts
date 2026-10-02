import { describe, expect, it } from 'vitest';
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { ConversationMessage, OperationView } from '@cloudhelm/contracts';
import { compactAgentContext, estimateContextTokens, generationTokenBudget, recoveryContextMessage, restoredConversationMessages } from './context-manager.js';

const user = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 1 });
const assistant = (content: unknown[]): AgentMessage => ({ role: 'assistant', content, timestamp: 1 }) as AgentMessage;
const call = (id: string, args: unknown = { command: 'ls' }) => ({ type: 'toolCall', id, name: 'run_remote', arguments: args });
const result = (id: string, text: string): AgentMessage => ({ role: 'toolResult', toolCallId: id, toolName: 'run_remote',
  content: [{ type: 'text', text }], timestamp: 1 }) as AgentMessage;
const operation: OperationView = { id: 'op-log', taskId: 'conversation', hostId: 'host', kind: 'command', preview: 'ls', status: 'succeeded', exitCode: 0, createdAt: 1 };

function expectCompletePairs(messages: AgentMessage[]): void {
  const calls = messages.flatMap((message) => message.role === 'assistant'
    ? message.content.flatMap((part) => part.type === 'toolCall' ? [part.id] : []) : []);
  const results = messages.flatMap((message) => message.role === 'toolResult' ? [message.toolCallId] : []);
  expect(results.sort()).toEqual(calls.sort());
  expect(new Set(calls).size).toBe(calls.length);
}

function compactWithinBudget(messages: AgentMessage[], contextWindow: number): AgentMessage[] {
  const compacted = compactAgentContext(messages, contextWindow, [operation]);
  expect(estimateContextTokens(compacted)).toBeLessThanOrEqual(Math.floor(contextWindow * 0.65));
  expectCompletePairs(compacted);
  return compacted;
}

describe('context budget management', () => {
  it('keeps a short conversation unchanged', () => {
    const messages = [user('Inspect the service')];
    expect(compactAgentContext(messages, 32_000, [])).toBe(messages);
  });

  it('shortens verbose output with operation references even with fewer than eight messages', () => {
    const argumentsValue = { command: 'journalctl --no-pager', cwd: '/srv/service' };
    const messages = [user('检查服务错误并保留已有数据'), assistant([call('inspect', argumentsValue)]),
      result('inspect', `Operation ID: op-log\nHost: host\nStatus: succeeded\n${'大量重复日志'.repeat(10_000)}\nEND OF CAPTURE`)];
    const compacted = compactWithinBudget(messages, 4000);
    expect(compacted.some((message) => message.role === 'toolResult' && message.toolCallId === 'inspect')).toBe(true);
    expect(JSON.stringify(compacted)).toContain('Operation ID: op-log');
    expect(JSON.stringify(compacted)).toContain('read_operation_log');
    expect(JSON.stringify(compacted)).toContain('END OF CAPTURE');
    expect(JSON.stringify(compacted)).not.toContain('大量重复日志'.repeat(100));
    const retainedCall = compacted.flatMap((message) => message.role === 'assistant' ? message.content : [])
      .find((part) => part.type === 'toolCall' && part.id === 'inspect');
    expect(retainedCall).toMatchObject({ arguments: argumentsValue });
    expect(messages[2]).toEqual(result('inspect', `Operation ID: op-log\nHost: host\nStatus: succeeded\n${'大量重复日志'.repeat(10_000)}\nEND OF CAPTURE`));
  });

  it('evicts a large historical call and its result together instead of changing tool arguments', () => {
    const original = user('Deploy this service without deleting existing data.');
    const recent = user('Only verify the running version now.');
    const messages = [original, assistant([call('old-write', { content: 'a'.repeat(20_000) })]), result('old-write', 'File written'),
      recent, assistant([call('current-check', { command: 'pwd' })]), result('current-check', 'Operation ID: op-log\n/srv/service')];
    const compacted = compactWithinBudget(messages, 3000);
    expect(compacted).toContainEqual(original);
    expect(compacted).toContainEqual(recent);
    expect(JSON.stringify(compacted)).not.toContain('old-write');
    expect(JSON.stringify(compacted)).toContain('current-check');
    expect(JSON.stringify(compacted)).toContain('op-log @ host: succeeded, exit 0');
  });

  it('treats a parallel batch and every result as one eviction group', () => {
    const messages = [user('Investigate'), assistant([call('parallel-a', { source: 'a'.repeat(12_000) }), call('parallel-b')]),
      result('parallel-a', 'First done'), result('parallel-b', 'Second done'), user('Summarize the result')];
    const compacted = compactWithinBudget(messages, 2500);
    expect(JSON.stringify(compacted)).not.toContain('parallel-a');
    expect(JSON.stringify(compacted)).not.toContain('parallel-b');
  });

  it('keeps the exact original goal and last two user instructions when omitting older turns', () => {
    const goal = user('Goal: inspect the service only.');
    const recent = user('不要重启，也不要修改网络。');
    const latest = user('只告诉我当前版本和健康检查结果。');
    const messages = [goal, user('Historical context '.repeat(1000)), assistant([{ type: 'text', text: 'Old analysis '.repeat(2000) }]),
      user('Older follow-up '.repeat(1000)), recent, latest];
    const compacted = compactWithinBudget(messages, 3000);
    expect(compacted).toContainEqual(goal);
    expect(compacted).toContainEqual(recent);
    expect(compacted).toContainEqual(latest);
    expect(compacted.some((message) => message.role === 'system' && typeof message.content === 'string' && message.content.includes('omitted'))).toBe(true);
    expect(JSON.stringify(compacted)).not.toContain('Historical context');
  });

  it('budgets Chinese conservatively instead of assuming four characters per token', () => {
    const english = [user('ab'.repeat(1000))];
    const chinese = [user('部署'.repeat(1000))];
    expect(estimateContextTokens(chinese)).toBeGreaterThan(estimateContextTokens(english) * 4);
    expect(compactAgentContext(english, 3000, [])).toBe(english);
    expect(() => compactAgentContext(chinese, 3000, [])).toThrow('超出所选模型的上下文窗口');
  });

  it('rejects one oversized current user message without silently truncating it', () => {
    const messages = [user('必须保留这个完整目标。'.repeat(6000))];
    const before = structuredClone(messages);
    expect(() => compactAgentContext(messages, 32_000, [])).toThrow('尚未发送此次请求');
    expect(messages).toEqual(before);
  });

  it('rejects oversized current tool arguments while preserving their exact call/result pair', () => {
    const messages = [user('Write the selected configuration'), assistant([call('current-write', { content: 'config'.repeat(30_000) })]),
      result('current-write', 'File written')];
    const before = structuredClone(messages);
    expect(() => compactAgentContext(messages, 32_000, [])).toThrow('完整工具参数');
    expect(messages).toEqual(before);
  });

  it('never removes required system instructions just to satisfy the budget', () => {
    const messages: AgentMessage[] = [{ role: 'system', content: 'Required authorization boundary '.repeat(4000), timestamp: 1 }, user('Continue')];
    expect(() => compactAgentContext(messages, 4000, [])).toThrow('超出所选模型的上下文窗口');
  });

  it('replaces its previous summary instead of accumulating summary messages', () => {
    const initial = compactWithinBudget([user('Inspect'), assistant([call('inspect')]), result('inspect', 'Log '.repeat(10_000))], 5000);
    const compacted = compactWithinBudget([...initial, assistant([{ type: 'text', text: 'Historical text '.repeat(10_000) }]), user('Explain the result')], 3000);
    expect(compacted.filter((message) => message.role === 'system' && typeof message.content === 'string' && message.content.startsWith('[CloudHelm context summary]'))).toHaveLength(1);
  });

  it('refuses to compact malformed tool history into apparently valid evidence', () => {
    expect(() => compactAgentContext([user('Inspect'), result('missing-call', 'output'.repeat(20_000))], 4000, [])).toThrow('缺少唯一对应调用');
    expect(() => compactAgentContext([user('Inspect'), assistant([call('missing-result', { content: 'x'.repeat(30_000) })])], 4000, [])).toThrow('尚无完整结果');
  });

  it('rejects an unavailable model window explicitly', () => {
    expect(() => compactAgentContext([user('Inspect')], 0, [])).toThrow('上下文窗口无效');
    expect(() => compactAgentContext([user('Inspect')], Number.NaN, [])).toThrow('上下文窗口无效');
  });
});

describe('restored conversations and fixed request overhead', () => {
  const task = { id: 'conversation', goal: '安装服务但保留已有生产数据。', createdAt: 1 };

  it('restores the exact original goal and latest two user intents while bounding older data', () => {
    const history: ConversationMessage[] = [
      { taskId: task.id, role: 'user', text: task.goal, createdAt: 1 },
      ...Array.from({ length: 40 }, (_, index) => ({ taskId: task.id, role: 'agent' as const, text: '旧日志'.repeat(40_000), createdAt: index + 2 })),
      { taskId: task.id, role: 'user', text: '切勿重启数据库。', createdAt: 50 },
      { taskId: task.id, role: 'user', text: '先告诉我目前的版本。', createdAt: 51 },
      { taskId: 'other-conversation', role: 'user', text: 'Foreign server instructions', createdAt: 52 }
    ];
    const restored = restoredConversationMessages(task, history);
    expect(restored[0]).toEqual(user(task.goal));
    expect(restored.some((message) => message.role === 'user' && message.content === history[41]?.text)).toBe(true);
    expect(restored.some((message) => message.role === 'user' && message.content === history[42]?.text)).toBe(true);
    expect(JSON.stringify(restored)).not.toContain('Foreign server instructions');
    expect(JSON.stringify(restored)).not.toContain('旧日志'.repeat(200));
    expect(JSON.stringify(restored).length).toBeLessThan(8000);
    expect(restored.every((message) => message.role === 'user')).toBe(true);

    const compacted = compactWithinBudget([...restored, recoveryContextMessage([operation])], 4000);
    expect(compacted.some((message) => message.role === 'user' && message.content === task.goal)).toBe(true);
    expect(compacted.some((message) => message.role === 'user' && message.content === '切勿重启数据库。')).toBe(true);
    expect(compacted.some((message) => message.role === 'user' && message.content === '先告诉我目前的版本。')).toBe(true);
    expect(JSON.stringify(compacted)).not.toContain('旧日志');
  });

  it('never truncates a large latest user intent while restoring history', () => {
    const text = '这个完整新目标必须保留。'.repeat(6000);
    const restored = restoredConversationMessages(task, [{ taskId: task.id, role: 'user', text, createdAt: 2 }]);
    expect(restored.some((message) => message.role === 'user' && message.content === text)).toBe(true);
    expect(() => compactAgentContext([...restored, recoveryContextMessage([])], 32_000, [])).toThrow('超出所选模型的上下文窗口');
  });

  it('keeps recovery references without embedding large command previews or output', () => {
    const message = recoveryContextMessage([{ ...operation, status: 'unknown', preview: 'long command '.repeat(20_000), outputTail: 'long output '.repeat(20_000) }]);
    expect(JSON.stringify(message)).toContain('op-log');
    expect(JSON.stringify(message)).toContain('unknown');
    expect(JSON.stringify(message)).not.toContain('long command');
    expect(JSON.stringify(message)).not.toContain('long output');
  });

  it('counts actual Pi system instructions, authorization paths and tool schemas in the input budget', () => {
    const agent = new Agent({ streamFn: () => { throw new Error('This context-only test must not send a model request'); }, initialState: {
      systemPrompt: `CloudHelm authorization paths: ${JSON.stringify(Array.from({ length: 100 }, (_, index) => `/selected/directory/${index}`))}`,
      tools: [{ name: 'run_remote', label: 'Run an audited operation', description: 'Required tool schema explanation '.repeat(500),
        replay: 'never', parameters: Type.Object({ command: Type.String() }),
        execute: async () => ({ content: [], details: undefined }) }], messages: [user('Inspect')]
    } });
    const initialSystem = agent.state.messages[0];
    expect(initialSystem?.role).toBe('system');
    expect(initialSystem && 'toolsAdded' in initialSystem && initialSystem.toolsAdded?.length).toBe(1);
    expect(estimateContextTokens(agent.state.messages)).toBeGreaterThan(4000);
    expect(() => compactAgentContext(agent.state.messages, 4000, [], { generationTokens: 1000 })).toThrow('超出所选模型的上下文窗口');
  });

  it('deducts explicit generation and additional provider overhead before admitting messages', () => {
    const messages = [user('a'.repeat(8000))];
    expect(compactAgentContext(messages, 10_000, [])).toBe(messages);
    expect(compactAgentContext(messages, 10_000, [], { generationTokens: 4000 })).toBe(messages);
    expect(() => compactAgentContext(messages, 10_000, [], { generationTokens: 4000, reservedTokens: 2000 })).toThrow('超出所选模型的上下文窗口');
    expect(() => compactAgentContext(messages, 10_000, [], { reservedTokens: 10_000 })).toThrow('已占满上下文窗口');
  });

  it('uses a generation cap that fits both the selected model and its window', () => {
    expect(generationTokenBudget({ contextWindow: 32_000, maxTokens: 8192 })).toBe(8000);
    expect(generationTokenBudget({ contextWindow: 128_000, maxTokens: 16_384 })).toBe(8192);
    expect(generationTokenBudget({ contextWindow: 4000, maxTokens: 4096 })).toBe(1000);
    expect(generationTokenBudget({ contextWindow: 32_000, maxTokens: 2048 })).toBe(2048);
  });
});
