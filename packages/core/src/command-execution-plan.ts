import type { CommandAnalysis } from './model.js';
import type { CommandExecutionPlan } from './remote-runtime.js';
import { isSudo, sudoTarget, supportsSudo } from './sudo-plan.js';

const bash = (source: string): string[] => ['/bin/bash', '--noprofile', '--norc', '-c', source];
const literal = (value: string): string => `'${value.replace(/'/gu, `'"'"'`)}'`;
// Sudo lists use separate processes. Shell state/flow cannot propagate across them.
const statefulShellCommands = new Set(['.', 'alias', 'bg', 'bind', 'break', 'builtin', 'cd', 'command', 'complete', 'compopt',
  'continue', 'declare', 'dirs', 'disown', 'enable', 'eval', 'exec', 'exit', 'export', 'fc', 'fg', 'getopts', 'hash',
  'history', 'jobs', 'let', 'local', 'logout', 'mapfile', 'popd', 'pushd', 'read', 'readarray', 'readonly', 'return',
  'set', 'shift', 'shopt', 'source', 'suspend', 'trap', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait']);

/** Resolve the complete launch and identities before fingerprinting, never in the executor. */
export function buildCommandExecutionPlan(analysis: CommandAnalysis, runAs: string): CommandExecutionPlan {
  if (analysis.hasError) throw new Error('Cannot plan an incomplete command parse');
  const authentication = analysis.calls.some((call) => /(?:^|\/)(?:sudo|su)$/u.test(call.name));
  if (!authentication) return { version: 1, shell: 'bash', steps: [
    { condition: 'always', argv: bash(analysis.raw), runAs, authentication: 'none' }
  ] };
  if (!supportsSudo(analysis)) throw new Error('Unsupported authentication form; no command was sent');
  return { version: 1, shell: 'bash', steps: analysis.steps!.map(({ call, condition }) => {
    if (!isSudo(call)) {
      if (statefulShellCommands.has(call.name)) throw new Error('Shell state or control flow cannot span isolated sudo processes; no command was sent');
      return { condition, argv: bash([call.name, ...call.args].map(literal).join(' ')), runAs, authentication: 'none' };
    }
    const target = sudoTarget(call)!;
    return { condition, argv: [call.name, '-A', ...call.args], runAs: target.runAs, authentication: 'sudo' };
  }) };
}

export function commandExecutionIdentities(plan: CommandExecutionPlan): string[] {
  return [...new Set(plan.steps.map((step) => step.runAs))];
}
