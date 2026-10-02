import type { OperationScope } from '@cloudhelm/core';

export function shellQuote(value: string): string { return `'${value.replace(/'/gu, "'\\''")}'`; }

/** A fresh non-login Bash prevents aliases/functions/environment from widening an approved command. */
export function commandEnvelope(command: string, scope: OperationScope, home: string, marker: string): string {
  const script = `if cd -- ${shellQuote(scope.cwd)}; then\n${command}\nelse false\nfi`;
  return `/usr/bin/env -i HOME=${shellQuote(home)} USER=${shellQuote(scope.runAs)} LOGNAME=${shellQuote(scope.runAs)} `
    + `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C TERM=xterm-256color `
    + `/bin/bash --noprofile --norc -c ${shellQuote(script)}; 'printf' '${marker}:%s\\n' "$?"\n`;
}
