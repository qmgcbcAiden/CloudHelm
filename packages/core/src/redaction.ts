/** Best-effort masking for stored and model-visible remote output. */
export function redactOutput(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s\r\n]+/giu, '$1[REDACTED]')
    .replace(/((?:password|passwd|api[_-]?key|token|secret)\s*[=:]\s*)[^\s'"\r\n]+/giu, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED KEY]');
}

/** Redacts complete lines across arbitrary SSH data-chunk boundaries. */
export class OutputRedactor {
  private pending = '';
  private inPrivateKey = false;

  push(chunk: string): string {
    this.pending += chunk.replace(/\u001b\[[\d;?]*[ -/]*[@-~]/gu, '');
    let safe = '';
    while (true) {
      const newline = this.pending.indexOf('\n');
      if (newline < 0) break;
      const line = this.pending.slice(0, newline + 1);
      this.pending = this.pending.slice(newline + 1);
      safe += this.line(line);
    }
    if (this.pending.length > 8192) {
      this.pending = '';
      safe += '[REDACTED LONG UNTERMINATED OUTPUT]\n';
    }
    return safe;
  }

  finish(): string {
    const safe = this.pending ? this.line(this.pending) : '';
    this.pending = '';
    return safe;
  }

  private line(line: string): string {
    if (this.inPrivateKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/u.test(line)) this.inPrivateKey = false;
      return '';
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(line)) {
      this.inPrivateKey = !/-----END [A-Z ]*PRIVATE KEY-----/u.test(line);
      return '[REDACTED PRIVATE KEY]\n';
    }
    return redactOutput(line);
  }
}
