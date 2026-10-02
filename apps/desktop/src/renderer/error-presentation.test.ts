import { describe, expect, it } from 'vitest';
import { errorMessage, inlineError, presentError, unwrapError } from './error-presentation.js';

describe('friendly error presentation', () => {
  it('unwraps nested Electron errors and offers model setup for the missing-key failure', () => {
    const error = new Error("Error invoking remote method 'cloudhelm:start-conversation': Error: 请先配置所选供应商的 API Key");
    expect(unwrapError(error)).toBe('请先配置所选供应商的 API Key');
    expect(presentError(error)).toMatchObject({ code: 'model-key-missing', title: '请先配置模型', action: 'model-settings', severity: 'warning' });
    expect(inlineError(error)).not.toMatch(/invoking|cloudhelm:|Error:/u);
    expect(unwrapError('Error: Error invoking remote method "cloudhelm:send-message": Error: Approval expired')).toBe('Approval expired');
  });

  it.each([
    ['All configured authentication methods failed', 'ssh-credentials'],
    ['SSH Agent is unavailable', 'ssh-agent'],
    ['Fingerprint is no longer pending', 'ssh-fingerprint-expired'],
    ['Host key verification failed', 'ssh-fingerprint'],
    ['Agent terminal authorization expired', 'approval-expired'],
    ['Input bridge authorization expired', 'input-expired'],
    ['Input request expired', 'input-expired'],
    ['Host is not connected', 'disconnected'],
    ['read ECONNRESET', 'disconnected'],
    ['connect ECONNREFUSED', 'connection-refused'],
    ['Timed out while waiting for handshake', 'timeout'],
    ['Permission denied', 'permission'],
    ['这段对话使用的 API Key 或地址已变更，请重新选择模型以确认新的连接和计费账户。', 'model-account-changed'],
    ['模型连接测试失败，请检查 Key、地址和模型权限', 'model-test'],
    ['status code: 401', 'model-auth'],
    ['OS credential encryption is unavailable', 'credential-storage'],
    ['旧的多主机对话仅供查看', 'read-only-history']
  ])('maps %s to actionable business copy', (message, code) => {
    expect(presentError(message).code).toBe(code);
    expect(presentError(message).description).not.toBe(message);
  });

  it('does not echo a credential even when a recognised error contains it', () => {
    const secrets = ['sk-1234567890abcdefghijkl', 'private key with spaces', 'p@ssw0rd', 'otp-8675309'];
    const cause = `Error invoking remote method 'cloudhelm:test-model': Error: Invalid API key: ${secrets[0]}
Authorization: Bearer ${secrets[1]}
https://user:${secrets[2]}@example.com/v1?access_token=${secrets[3]}`;
    const rendered = JSON.stringify(presentError(cause));
    expect(presentError(cause).code).toBe('model-auth');
    for (const secret of secrets) expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain('https://');
  });

  it('never exposes arbitrary response bodies, error objects or stacks in unknown errors', () => {
    const cause = new Error('The server echoed my completely arbitrary secret phrase');
    const result = presentError(cause);
    expect(result.code).toBe('unexpected');
    expect(result.details).toContain('未显示未经识别');
    expect(JSON.stringify(result)).not.toContain('arbitrary secret');
    expect(errorMessage({ password: 'hidden', message: 'do not stringify me' })).toBe('Unknown error');
    expect(JSON.stringify(presentError({ apiKey: 'hidden' }))).not.toContain('hidden');
  });

  it('does not capture secret text between known words', () => {
    for (const cause of [
      'Encrypted private my password with spaces no passphrase',
      'SSH password=super-secret disconnected',
      '上下文中密码是 super-secret，无法安全整理'
    ]) expect(presentError(cause).details).not.toMatch(/super-secret|my password/u);
  });

  it('keeps disconnect recovery distinct from a retry instruction', () => {
    const value = presentError('Connection lost');
    expect(value.description).toContain('可能仍在运行');
    expect(value.description).toContain('核验结果');
    expect(value.action).toBeUndefined();
  });
});
