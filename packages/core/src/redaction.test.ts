import { describe, expect, it } from 'vitest';
import { OutputRedactor, redactOutput } from './redaction.js';

describe('sensitive output masking', () => {
  it('masks a secret split between SSH chunks before storage', () => {
    const redactor = new OutputRedactor();
    const first = redactor.push('token=very-se');
    const second = redactor.push('cret-value\n');
    expect(first + second).toBe('token=[REDACTED]\n');
  });

  it('masks multi-line private keys and bearer tokens', () => {
    const redactor = new OutputRedactor();
    const output = redactor.push('-----BEGIN PRIVATE KEY-----\nABCD\n-----END PRIVATE KEY-----\nAuthorization: Bearer abc123\n');
    expect(output).not.toContain('ABCD');
    expect(output).not.toContain('abc123');
    expect(redactOutput('password=abc')).toBe('password=[REDACTED]');
  });
});
