import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { RuntimeProfile } from '@cloudhelm/contracts/runtime';
import { compactAgentContext } from './context-manager.js';
import { ConversationModel } from './conversation-model.js';

const profile = (modelId: string, apiKey: string, baseUrl = 'http://localhost:1234/v1'): RuntimeProfile => ({
  provider: 'cloudhelm-custom', modelId, apiKey, baseUrl
});

describe('conversation model selection', () => {
  it('applies independent reviewer settings at the next request without changing the current review identity', () => {
    const selection = new ConversationModel(profile('model-a', 'main-key'));
    selection.setReviewKey('review-key');
    expect(selection.current().profile.jevKey).toBeUndefined();
    expect(selection.prepare().profile.jevKey).toBe('review-key');
    selection.setReviewKey();
    expect(selection.current().profile.jevKey).toBe('review-key');
    expect(selection.prepare().profile.jevKey).toBeUndefined();
    expect(selection.current().profile.apiKey).toBe('main-key');
  });

  it('keeps an in-flight request on its original model and key until the next prepare boundary', () => {
    const selection = new ConversationModel(profile('first-model', 'first-key'));
    const inFlight = selection.current();
    selection.select(profile('next-model', 'next-key', 'http://localhost:4321/v1'));
    expect(selection.current()).toBe(inFlight);
    expect(selection.current().profile.apiKey).toBe('first-key');

    const nextRequest = selection.prepare();
    expect(nextRequest.model.id).toBe('next-model');
    expect(nextRequest.profile.apiKey).toBe('next-key');
    expect(nextRequest.model.baseUrl).toBe('http://localhost:4321/v1');
    expect(nextRequest.catalog).not.toBe(inFlight.catalog);
    expect(inFlight.profile.apiKey).toBe('first-key');
    expect(inFlight.model.baseUrl).toBe('http://localhost:1234/v1');
    expect(selection.current()).toBe(nextRequest);
  });

  it('copies selected credentials and isolates separate conversations', () => {
    const input = profile('model-a', 'account-a-key');
    const conversationA = new ConversationModel(input);
    const conversationB = new ConversationModel(profile('model-b', 'account-b-key'));
    input.apiKey = 'mutated-caller-key';
    const nextInput = profile('model-c', 'account-c-key');
    conversationA.select(nextInput);
    nextInput.apiKey = 'mutated-next-key';
    expect(conversationA.current().profile.apiKey).toBe('account-a-key');
    expect(conversationA.prepare().profile.apiKey).toBe('account-c-key');
    expect(conversationB.prepare().profile.apiKey).toBe('account-b-key');
    expect(conversationB.current().model.id).toBe('model-b');
  });

  it('applies only the latest choice at the next boundary and keeps a valid selection after invalid input', () => {
    const selection = new ConversationModel(profile('original', 'first-key'));
    selection.select(profile('intermediate', 'second-key'));
    selection.select(profile('latest', 'third-key'));
    expect(() => selection.select({ provider: 'unknown-provider', modelId: 'unknown', apiKey: 'invalid' })).toThrow();
    expect(selection.current().model.id).toBe('original');
    expect(selection.prepare().model.id).toBe('latest');
    expect(selection.current().profile.apiKey).toBe('third-key');
  });

  it('provides the new smaller context window before compacting the next request', () => {
    const selection = new ConversationModel({ provider: 'openai', modelId: 'gpt-4.1', apiKey: 'large-window-key' });
    const messages = [
      { role: 'user', content: 'Inspect the service', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'inspect', name: 'run_remote', arguments: { command: 'journalctl' } }] },
      { role: 'toolResult', toolCallId: 'inspect', toolName: 'run_remote', content: [{ type: 'text', text: 'log '.repeat(80_000) }] },
      ...Array.from({ length: 10 }, (_, index) => ({ role: 'user', content: `Continue ${index}`, timestamp: index + 2 }))
    ] as AgentMessage[];
    expect(compactAgentContext(messages, selection.current().model.contextWindow, [])).toBe(messages);
    selection.select(profile('small-model', 'small-window-key'));
    const next = selection.prepare();
    expect(next.model.contextWindow).toBe(32_000);
    const compacted = compactAgentContext(messages, next.model.contextWindow, []);
    expect(compacted).not.toBe(messages);
    expect(JSON.stringify(compacted)).not.toContain('log '.repeat(1000));
    expect(compacted.some((item) => item.role === 'toolResult' && item.toolCallId === 'inspect')).toBe(true);
    expect(compacted.some((item) => item.role === 'assistant'
      && item.content.some((part) => part.type === 'toolCall' && part.id === 'inspect'))).toBe(true);
  });
});
