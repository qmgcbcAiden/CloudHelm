import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeBridge } from '../../../apps/desktop/src/main/runtime-bridge.js';
import { createRequestBudget, reserveRoundRequest } from '@cloudhelm/core';
import { resolve } from 'node:path';

const fixture = vi.hoisted(() => ({ fork: vi.fn(), child: undefined as unknown as import('node:events').EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>
} }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { app: { isPackaged: false, getAppPath: () => '/fixture/out/main' }, utilityProcess: { fork: (...args: unknown[]) => {
    fixture.fork(...args);
    fixture.child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
    return fixture.child;
  } } };
});
afterEach(() => vi.useRealTimers());

function setup(budget?: ConstructorParameters<typeof RuntimeBridge>[4]) {
  const onEvent = vi.fn(); const readLog = vi.fn(() => ({ text: '', nextCursor: 0, more: false })); const stopped = vi.fn();
  const bridge = new RuntimeBridge(onEvent, readLog, stopped, undefined, budget);
  return { bridge, onEvent, readLog, stopped, child: fixture.child };
}

it('resolves unpackaged native resources from the main bundle rather than Electron appPath', () => {
  const f = setup();
  expect(fixture.fork).toHaveBeenLastCalledWith(expect.any(String), [], expect.objectContaining({ env: expect.objectContaining({
    CLOUDHELM_NATIVE_DIR: resolve(import.meta.dirname, '../../../apps/desktop/resources/native')
  }) }));
  f.bridge.close();
});

describe('budget acknowledgments', () => {
  const query = { budgetRequest: { id: 'rpc', command: { kind: 'current', taskId: 'task' } } };
  it('fails closed if no budget authority is assembled or the authority fails', () => {
    const missing = setup(); missing.child.emit('message', query);
    expect(missing.child.postMessage).toHaveBeenLastCalledWith({ budgetResult: { id: 'rpc', error: 'budget-unavailable' } });
    missing.bridge.close();
    const failed = setup(() => { throw new Error('private storage details'); }); failed.child.emit('message', query);
    expect(failed.child.postMessage).toHaveBeenLastCalledWith({ budgetResult: { id: 'rpc', error: 'budget-unavailable' } });
    failed.bridge.close();
  });
  it('does not retry or undo a committed reservation when sending its acknowledgment fails', () => {
    let committed = createRequestBudget('round');
    const authority = vi.fn(() => {
      committed = reserveRoundRequest(committed);
      return { value: { kind: 'reserve' as const, taskId: 'task', budget: committed, duplicate: false } };
    });
    const request = { budgetRequest: { id: 'rpc', command: { kind: 'reserve', taskId: 'task', roundId: 'round',
      attempt: { logicalRequestId: 'logical', attempt: 1, purpose: 'conversation', transport: 'http' } } } };
    const f = setup(authority);
    f.child.postMessage.mockImplementation(() => { throw new Error('channel closed'); });
    expect(() => f.child.emit('message', request)).not.toThrow();
    expect(authority).toHaveBeenCalledOnce(); expect(f.child.postMessage).toHaveBeenCalledOnce();
    expect(committed.roundUsed).toBe(1);
    f.bridge.close(); f.child.emit('message', request);
    expect(authority).toHaveBeenCalledOnce(); expect(committed.roundUsed).toBe(1);
  });
});

describe('runtime shutdown', () => {
  it('rejects pending calls immediately and discards late events and log reads', async () => {
    vi.useFakeTimers();
    const f = setup();
    const call = f.bridge.call({ method: 'has-task', taskId: 'task' });
    const rejected = expect(call).rejects.toThrow('runtime stopped');
    f.bridge.close(); f.bridge.close();
    await rejected;
    f.child.emit('message', { event: { type: 'task-status', taskId: 'task', status: 'paused' } });
    f.child.emit('message', { readLog: { id: 'late', taskId: 'task', operationId: 'op', cursor: 0 } });
    f.child.emit('exit', 0);
    expect(f.onEvent).not.toHaveBeenCalled(); expect(f.readLog).not.toHaveBeenCalled(); expect(f.stopped).not.toHaveBeenCalled();
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    await expect(f.bridge.call({ method: 'has-task', taskId: 'new' })).rejects.toThrow('已停止');
    expect(f.child.postMessage).toHaveBeenCalledOnce();
  });

  it('still records an unexpected runtime crash once while the app is open', () => {
    const f = setup();
    f.child.emit('exit', 1); f.child.emit('exit', 1);
    expect(f.stopped).toHaveBeenCalledOnce();
    f.bridge.close(); expect(f.child.kill).not.toHaveBeenCalled();
  });

  it('cleans up its timeout if sending a request fails', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.child.postMessage.mockImplementation(() => { throw new Error('IPC channel closed'); });
    await expect(f.bridge.call({ method: 'has-task', taskId: 'task' })).rejects.toThrow('不可用');
    expect(vi.getTimerCount()).toBe(0);
    f.bridge.close();
  });
});

it('routes private file previews without ordinary events, diagnostics, log reads or responses', () => {
  const onEvent = vi.fn(); const readLog = vi.fn(); const diagnostic = vi.fn(); const preview = vi.fn();
  const bridge = new RuntimeBridge(onEvent, readLog, undefined, diagnostic, undefined, undefined, undefined, preview);
  const payload = { operationId: 'operation', preview: { before: 'private old', after: 'new' } };
  fixture.child.emit('message', { filePreview: payload });
  expect(preview).toHaveBeenCalledWith(payload); expect(onEvent).not.toHaveBeenCalled(); expect(readLog).not.toHaveBeenCalled();
  expect(diagnostic).not.toHaveBeenCalled(); expect(fixture.child.postMessage).not.toHaveBeenCalled();
  bridge.close();
});
