import path from 'node:path';
import type { CommandCall } from '@cloudhelm/core';

/** Decode literal quoting only. This never expands variables or executes shell text. */
export function shellWord(text: string): string {
  text = text.replace(/\$'((?:\\.|[^'])*)'/gu, (_match: string, body: string) => {
    const decoded = body.replace(/\\(?:x([\da-f]{1,2})|u([\da-f]{4})|U([\da-f]{8})|([0-7]{1,3})|(.))/giu,
      (_escape: string, hex: string, unicode: string, wide: string, octal: string, char: string) => {
        if (hex || unicode || wide) {
          const code = Number.parseInt(hex || unicode || wide, 16);
          return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
        }
        if (octal) return String.fromCharCode(Number.parseInt(octal, 8));
        return ({ a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' } as Record<string, string>)[char] ?? char;
      });
    return `'${decoded.replace(/'/gu, "'\\''")}'`;
  });
  let quote = '';
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === quote) { quote = ''; continue; }
    if (!quote && (char === "'" || char === '"')) { quote = char; continue; }
    if (char === '\\' && quote !== "'" && index + 1 < text.length) {
      const next = text[index + 1]!;
      if (!quote || /["\\$`\n]/u.test(next)) { result += next === '\n' ? '' : next; index++; continue; }
    }
    result += char;
  }
  return result;
}

const VALUE_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-R', '-D', '-T', '-h', '--user', '--group', '--prompt', '--close-from', '--chroot', '--chdir', '--command-timeout', '--host']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  command: new Set(), exec: new Set(['-a']), nohup: new Set(), busybox: new Set(),
  nice: new Set(['-n', '--adjustment']), time: new Set(['-f', '-o', '--format', '--output']),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']), setsid: new Set(),
  xargs: new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars']),
  runuser: new Set(['-u', '-g', '-G', '--user', '--group', '--supp-group'])
};

/** Find the executable after a known launcher; embedded scripts are handled separately. */
export function wrappedCommand(call: CommandCall): CommandCall | undefined {
  const name = path.posix.basename(call.name);
  const values = VALUE_OPTIONS[name];
  if (!values) return;
  let index = 0;
  while (index < call.args.length) {
    const arg = call.args[index]!;
    if (arg === '--') { index++; break; }
    if (arg.startsWith('-')) {
      if (name === 'env' && (arg.startsWith('-S') || arg === '--split-string' || arg.startsWith('--split-string='))) return;
      index += values.has(arg) ? 2 : 1;
    } else if (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(arg)) index++;
    else break;
  }
  if (name === 'timeout') index++;
  if (!call.args[index]) return;
  return { ...call, name: call.args[index]!, args: call.args.slice(index + 1) };
}

export function embeddedShell(call: CommandCall): string | undefined {
  const name = path.posix.basename(call.name);
  if (name === 'eval') return call.args.join(' ');
  if (/^(?:python\d*(?:\.\d+)?|node|perl|ruby)$/u.test(name)) {
    const flag = call.args.findIndex((arg) => arg === '-c' || arg === '-e');
    const source = call.args[flag + 1];
    // Best-effort recognition of literal shell-launch calls. This does not claim to
    // understand arbitrary program semantics, encoded code, or scripts on disk.
    if (flag >= 0 && source) {
      const scripts = [...source.matchAll(/(?:\bos\.system|\bexecSync|\bexec|\bsystem|\bsubprocess\.(?:run|call|check_call))\(\s*(['"])((?:\\.|(?!\1).)*)\1/gu)]
        .map((literal) => literal[2]!.replace(/\\(['"\\])/gu, '$1'));
      for (const literal of source.matchAll(/(?:\bshutil\.rmtree|\bos\.(?:remove|unlink)|\b(?:fs\.)?(?:rmSync|rmdirSync|unlinkSync))\(\s*(['"])([\w/.-]+)\1/gu)) {
        scripts.push(`rm -rf '${literal[2]}'`);
      }
      if (scripts.length) return scripts.join('\n');
    }
  }
  if (name === 'env') {
    const split = call.args.findIndex((arg) => arg === '-S' || arg.startsWith('-S') || arg === '--split-string' || arg.startsWith('--split-string='));
    if (split >= 0) {
      const option = call.args[split]!;
      return option.startsWith('--split-string=') ? option.slice(15)
        : option.startsWith('-S') && option.length > 2 ? option.slice(2) : call.args[split + 1];
    }
  }
  if (!['bash', 'sh', 'dash', 'zsh', 'ksh', 'su', 'runuser'].includes(name)) return;
  const index = call.args.findIndex((arg) => arg === '--command' || /^-[^-]*c$/u.test(arg) || arg.startsWith('--command='));
  if (index < 0) return;
  return call.args[index]!.startsWith('--command=') ? call.args[index]!.slice(10) : call.args[index + 1];
}

/** find -exec/-execdir commands are executable syntax despite being AST arguments. */
export function findCommands(call: CommandCall): CommandCall[] {
  if (path.posix.basename(call.name) !== 'find') return [];
  return call.args.flatMap((arg, index) => {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(arg) || !call.args[index + 1]) return [];
    const end = call.args.findIndex((value, offset) => offset > index && (value === ';' || value === '+'));
    return [{ ...call, name: call.args[index + 1]!, args: call.args.slice(index + 2, end < 0 ? undefined : end) }];
  });
}
