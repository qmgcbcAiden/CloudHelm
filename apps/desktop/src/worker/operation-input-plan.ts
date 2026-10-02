import type { CommandAnalysis, CommandCall } from '@cloudhelm/core';

export interface InputPlan {
  auth?: 'sudo' | 'su';
  user?: string;
  command: string;
  aptInstall: boolean;
}

export function supportedSuHost(probe: string, user: string): boolean {
  if (!/su from util-linux/u.test(probe) || !/setsid from util-linux/u.test(probe)) return false;
  const lines = probe.split(/\r?\n/u);
  const entry = lines.find((line) => line.startsWith(`${user}:`))?.split(':');
  const shell = entry?.length === 7 ? entry[6] : undefined;
  // Non-root su ignores --shell for restricted accounts. Never let an arbitrary
  // target login program consume the inherited authentication FIFO.
  return !!shell && ['/bin/sh', '/usr/bin/sh', '/bin/bash', '/usr/bin/bash', '/bin/dash', '/usr/bin/dash'].includes(shell)
    && lines.includes(shell) && lines.includes('/bin/sh');
}

export function quoteShell(value: string): string { return `'${value.replace(/'/gu, "'\\''")}'`; }

function argvCommand(call: CommandCall): string { return [call.name, ...call.args].map(quoteShell).join(' '); }

/** Only the known top-level executable may request credentials. Nested/opaque launchers cannot. */
export function inputPlan(analysis: CommandAnalysis): InputPlan | undefined {
  if (analysis.hasError || analysis.hasPipeline || analysis.hasRedirection || analysis.hasExpansion) return;
  const first = analysis.calls[0];
  if (!first || first.dynamic || first.redirects) return;
  if (first.name === 'su' || first.name === '/usr/bin/su' || first.name === '/bin/su') {
    if (first.args.length !== 3 || first.args[1] !== '-c' || !/^[a-z_][a-z0-9_-]*[$]?$/iu.test(first.args[0]!)) return;
    return { auth: 'su', user: first.args[0], command: first.args[2]!, aptInstall: false };
  }
  const sudo = first.name === 'sudo' || first.name === '/usr/bin/sudo';
  let call = first;
  let user: string | undefined;
  if (sudo) {
    let index = 0;
    if (first.args[0] === '-u' && /^[a-z_][a-z0-9_-]*[$]?$/iu.test(first.args[1] ?? '')) {
      user = first.args[1]; index = 2;
      if (user !== 'root') return;
    }
    if (first.args[index] === '--') index++;
    if (!first.args[index] || first.args[index]!.startsWith('-')) return;
    call = { ...first, name: first.args[index]!, args: first.args.slice(index + 1) };
    if (analysis.calls.length !== 2) return;
  } else if (analysis.calls.length !== 1 || analysis.hasCompound) return;
  const apt = call.name === 'apt' || call.name === 'apt-get' || call.name === '/usr/bin/apt' || call.name === '/usr/bin/apt-get';
  // Do not reuse approval for package removals, arbitrary config/hooks or package-name modifiers.
  const aptInstall = apt && call.args[0] === 'install' && call.args.length > 1
    && call.args.slice(1).every((arg) => /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?(?:=[a-z0-9.+:~_-]+)?$/iu.test(arg) && !arg.endsWith('-'));
  if (!sudo && !aptInstall) return;
  return { auth: sudo ? 'sudo' : undefined, user, command: argvCommand(call), aptInstall };
}

export interface InputPaths { directory: string; secret: string; prompt: string; normal: string; askpass: string }
export function inputPaths(token: string): InputPaths {
  const directory = `/tmp/.cloudhelm-input-${token}`;
  return { directory, secret: `${directory}/secret`, prompt: `${directory}/prompt`, normal: `${directory}/normal`, askpass: `${directory}/askpass` };
}

export function setupInput(paths: InputPaths, promptToken: string): string {
  const helper = `#!/bin/sh\nprintf '%s\\n' ${quoteShell(promptToken)} > ${quoteShell(paths.prompt)} || exit 1\nIFS= read -r secret < ${quoteShell(paths.secret)} || exit 1\nprintf '%s\\n' "$secret"\nunset secret\n`;
  return `umask 077; mkdir -m 700 -- ${quoteShell(paths.directory)} && mkfifo -- ${[paths.secret, paths.prompt, paths.normal].map(quoteShell).join(' ')} && printf '%s' ${quoteShell(helper)} > ${quoteShell(paths.askpass)} && chmod 700 ${quoteShell(paths.askpass)}`;
}

export function suPayload(command: string, authEnd: string): string {
  // PAM implementations may keep duplicated descriptors. On the supported Linux
  // path, close every inherited fd above stderr before evaluating the payload.
  const closeInherited = 'for descriptor in /proc/$$/fd/*; do descriptor=${descriptor##*/}; case "$descriptor" in ""|*[!0-9]*|0|1|2) continue;; esac; eval "exec $descriptor<&-"; done';
  const payload = `${closeInherited}\n${command}`;
  return `exec 0</dev/null\nprintf '%s\\n' ${quoteShell(authEnd)} >&2\nexec 2>&3 3>&-\nunset BASH_ENV ENV\nexec /bin/bash --noprofile --norc -c ${quoteShell(payload)}`;
}

/** Credentials never become stdin of the reviewed payload, including after a late answer. */
export function bridgeCommand(plan: InputPlan, paths: InputPaths, authEnd: string): string {
  const input = plan.aptInstall ? quoteShell(paths.normal) : '/dev/null';
  if (plan.auth === 'su') {
    // setsid removes the controlling terminal. The forced noninteractive POSIX shell closes
    // the inherited authentication FIFO before any payload expansion/evaluation takes place.
    const payload = suPayload(plan.command, authEnd);
    return `LC_ALL=C /usr/bin/setsid --wait /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/su --shell /bin/sh ${quoteShell(plan.user!)} -c ${quoteShell(payload)} < ${quoteShell(paths.secret)} 3>&2 2> ${quoteShell(paths.prompt)}`;
  }
  if (plan.auth === 'sudo') {
    const payload = `exec 0<${input}\nexport LC_ALL=C\nunset SUDO_ASKPASS\nprintf '%s\\n' ${quoteShell(authEnd)} > ${quoteShell(paths.prompt)}\nexec ${plan.command}`;
    const user = plan.user ? `-u ${quoteShell(plan.user)} ` : '';
    return `SUDO_ASKPASS=${quoteShell(paths.askpass)} /usr/bin/sudo -A ${user}-- /bin/sh -c ${quoteShell(payload)}`;
  }
  return `LC_ALL=C ${plan.command} < ${input}`;
}

/** Only the latest complete C-locale apt transaction summary can authorize a bounded yes. */
export function aptHasNoRemovals(output: string): boolean {
  const summaries = [...output.matchAll(/(?:^|[\r\n])(\d+) upgraded, (\d+) newly installed, (\d+) to remove and (\d+) not upgraded\./gu)];
  return summaries.at(-1)?.[3] === '0' && !/(?:REMOVED|essential packages|downgraded|overwrite|configuration file)/iu.test(output);
}
