import path from 'node:path';
import type { CommandAnalysis, CommandCall, ProposedOperation, SafetyDecision, SafetySettings } from './model.js';

const CRITICAL_TREES = new Set(['/', '/etc', '/usr', '/usr/bin', '/usr/sbin', '/usr/lib', '/boot', '/home', '/root', '/var', '/var/lib', '/var/lib/docker', '/bin', '/sbin', '/lib', '/lib64', '/dev', '/proc', '/sys']);
const QUERY_COMMANDS = new Set(['pwd', 'whoami', 'id', 'uname', 'uptime', 'date', 'df', 'free', 'hostname', 'ls', 'stat', 'cat']);
const BAD_DISK_TOOLS = new Set(['mkfs', 'mkfs.ext4', 'mkfs.xfs', 'mkswap', 'wipefs', 'sfdisk', 'fdisk', 'parted', 'blkdiscard']);
const CRITICAL_FILES = new Set(['/etc/passwd', '/etc/shadow', '/etc/sudoers', '/etc/fstab']);

function decision(verdict: SafetyDecision['verdict'], ruleId: string, reason: string): SafetyDecision {
  return { verdict, ruleId, reason };
}

function literalPath(value: string, cwd: string): string | null {
  if (!value || /[$`*?{}\[\]<>\n\r]/u.test(value)) return null;
  const unquoted = value.replace(/^(['"])(.*)\1$/u, '$2');
  if (!unquoted || unquoted.startsWith('~')) return null;
  return path.posix.resolve(cwd, unquoted);
}

function isInside(target: string, root: string): boolean {
  const normalized = path.posix.resolve(root);
  return target === normalized || target.startsWith(normalized === '/' ? '/' : `${normalized}/`);
}

function isRecursive(args: string[]): boolean {
  return args.some((arg) => arg === '--recursive' || /^-[a-zA-Z]*[rR]/u.test(arg));
}

function criticalMassTarget(value: string, cwd: string): boolean {
  const normalized = literalPath(value, cwd);
  if (normalized && CRITICAL_TREES.has(normalized)) return true;
  const unquoted = value.replace(/^(['"])(.*)\1$/u, '$2');
  const glob = unquoted.search(/[*?{\[]/u);
  if (glob < 0) return false;
  const base = path.posix.resolve(cwd, unquoted.slice(0, glob));
  return CRITICAL_TREES.has(base) || [...CRITICAL_TREES].some((target) => target.startsWith(base));
}

function isBlockDevice(value: string): boolean {
  return /^\/dev\/(?:[hsv]d[a-z]+\d*|xvd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|disk\d+(?:s\d+)?|(?:mapper|disk)\/.+|dm-\d+|loop\d+|md\d+|zram\d+)$/u.test(value);
}

function writableRootMount(args: string[]): boolean {
  return args.some((arg) => {
    const volume = arg.replace(/^(?:--volume=|-v)/u, '');
    if (volume.startsWith('/:')) return !(volume.split(':')[2] ?? '').split(',').includes('ro');
    const mount = arg.replace(/^--mount=/u, '');
    return /(?:^|,)(?:source|src)=\/(?:,|$)/u.test(mount)
      && !/(?:^|,)(?:readonly(?:=true)?|ro)(?:,|$)/u.test(mount);
  });
}

function findRoots(args: string[]): string[] {
  const roots: string[] = [];
  for (const arg of args) {
    if (!roots.length && ['-H', '-L', '-P'].includes(arg)) continue;
    if (arg.startsWith('-') || arg === '(' || arg === '!') break;
    roots.push(arg);
  }
  return roots.length ? roots : ['.'];
}

function hardCommandReason(analysis: CommandAnalysis, cwd: string): string | null {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(analysis.raw)) return 'Terminal control bytes are not accepted in Agent commands';
  let effectiveCwd = cwd;
  for (const rawCall of analysis.calls) {
    const call = rawCall;
    const name = path.posix.basename(call.name);
    if (name === 'cd' || name === 'pushd') effectiveCwd = literalPath(call.args.at(-1) ?? '', effectiveCwd) ?? effectiveCwd;
    if (BAD_DISK_TOOLS.has(name) || name.startsWith('mkfs.')) return 'Disk formatting or partition mutation is reserved for manual operation';
    if (name === 'dd' && call.args.some((arg) => isBlockDevice(arg.replace(/^of=/u, '')))) return 'Direct disk overwrite is forbidden';
    if (['cp', 'mv', 'install', 'tee', 'truncate', 'shred'].includes(name) && call.args.some((arg) => isBlockDevice(arg.replace(/^--[^=]+=/u, '')))) return 'Direct disk mutation is forbidden';
    if (['rm', 'mv', 'tee', 'truncate', 'shred'].includes(name) && call.args.some((arg) => CRITICAL_FILES.has(literalPath(arg, effectiveCwd) ?? ''))) return 'Destruction of essential system files is forbidden';
    if (['mv', 'rmdir'].includes(name) && call.args.some((arg) => criticalMassTarget(arg, effectiveCwd))) return 'Removing or relocating a system tree is forbidden';
    if (name === 'rsync' && call.args.some((arg) => arg.startsWith('--delete')) && criticalMassTarget(call.args.at(-1) ?? '', effectiveCwd)) return 'Deleting system-tree contents through synchronization is forbidden';
    if (name === 'find' && findRoots(call.args).some((arg) => criticalMassTarget(arg, effectiveCwd))
      && analysis.calls.some((nested) => ['rm', 'shred', 'truncate'].includes(path.posix.basename(nested.name)))) return 'Destructive traversal of a system tree is forbidden';
    if (name === 'find' && call.args.includes('-delete') && findRoots(call.args).some((arg) => criticalMassTarget(arg, effectiveCwd))) return 'Mass deletion of a system tree is forbidden';
    if ((name === 'chmod' || name === 'chown') && isRecursive(call.args) && call.args.some((arg) => criticalMassTarget(arg, effectiveCwd))) {
      return 'Recursive permission changes to a system tree are forbidden';
    }
    if (name === 'rm' && isRecursive(call.args)) {
      const targets = call.args.filter((arg) => !arg.startsWith('-'));
      if (targets.some((arg) => criticalMassTarget(arg, effectiveCwd))) {
        return 'Recursive deletion of a system tree is forbidden';
      }
    }
    if (name === 'docker' && call.args.some((arg) => arg === 'run' || arg === 'create') && writableRootMount(call.args)) {
      return 'Writable host-root mount is forbidden';
    }
  }
  if (analysis.redirectTargets.some(isBlockDevice)) return 'Direct redirection to a block device is forbidden';
  if (analysis.redirectTargets.some((target) => CRITICAL_FILES.has(literalPath(target, effectiveCwd) ?? ''))) return 'Overwriting essential system files is forbidden';
  return null;
}

function protectedTarget(operation: ProposedOperation): boolean {
  const { protectedPaths, cwd } = operation.scope;
  const raw = operation.kind === 'write-file' || operation.kind === 'delete-path' ? operation.path
    : operation.kind === 'upload' ? operation.remotePath : null;
  if (!raw) return false;
  const target = literalPath(raw, cwd);
  if (!target) return false;
  return protectedPaths.some((protectedPath) => isInside(target, protectedPath)
    || (operation.kind === 'delete-path' && isInside(path.posix.resolve(protectedPath), target)));
}

function protectedCommandTarget(operation: ProposedOperation, analysis: CommandAnalysis): boolean {
  const { protectedPaths, cwd } = operation.scope;
  let effectiveCwd = cwd;
  const overlaps = (raw: string, destructive: boolean): boolean => {
    const value = raw.replace(/^[A-Za-z_-][A-Za-z_0-9-]*=/u, '');
    // A literal prefix of a glob still identifies a protected tree.
    const prefix = value.split(/[*?{\[]/u)[0] ?? '';
    const target = literalPath(prefix, effectiveCwd);
    if (target === null) return false;
    return protectedPaths.some((root) => isInside(target, root)
      || (destructive && isInside(path.posix.resolve(root), target))
      || (prefix !== value && path.posix.resolve(root).startsWith(target)));
  };
  if (analysis.redirectTargets.some((target) => overlaps(target, false))) return true;
  for (const call of analysis.calls) {
    const name = path.posix.basename(call.name);
    if (name === 'echo' || name === 'printf') continue;
    const destructive = ['rm', 'rmdir', 'mv', 'chmod', 'chown', 'find', 'rsync'].includes(name);
    if (call.args.some((arg) => (!arg.startsWith('-') || arg.includes('=')) && overlaps(arg, destructive))) return true;
    if (name === 'cd' || name === 'pushd') effectiveCwd = literalPath(call.args.at(-1) ?? '', effectiveCwd) ?? effectiveCwd;
  }
  if (analysis.redirectTargets.some((target) => overlaps(target, false))) return true;
  return false;
}

function isQuery(call: CommandCall): boolean {
  if (call.dynamic || call.redirects) return false;
  const name = path.posix.basename(call.name);
  if (![name, `/bin/${name}`, `/usr/bin/${name}`].includes(call.name)) return false;
  if (name === 'hostname') return call.args.every((arg) => ['-a', '-A', '-d', '-f', '-i', '-I', '-s', '--fqdn', '--short', '--domain', '--ip-address', '--all-ip-addresses'].includes(arg));
  if (name === 'date') return call.args.every((arg) => ['-u', '-R', '-I', '--utc', '--rfc-email', '--iso-8601'].includes(arg) || (arg.startsWith('+') && !/[\r\n]/u.test(arg)));
  if (name === 'ifconfig') {
    return call.args.length === 0 || (call.args.length === 1 && (call.args[0] === '-a' || /^[a-zA-Z][\w.:-]*$/u.test(call.args[0] ?? '')));
  }
  if (!QUERY_COMMANDS.has(name)) return false;
  if (call.args.some((arg) => /[$`*?{}\[\]<>\n\r]/u.test(arg))) return false;
  if (name === 'cat') {
    const paths = call.args[0] === '--' ? call.args.slice(1) : call.args;
    return paths.length > 0 && paths.every((value) => value.length > 0 && !/^[-~]/u.test(value)
      && !/[\u0000-\u001f\u007f]/u.test(value) && !/^\/(?:dev\/(?:stdin|fd\/0)|proc\/(?:self|\d+)\/fd\/0)$/u.test(value));
  }
  if (name === 'ls' || name === 'stat') return !call.args.some((arg) => arg.startsWith('--output='));
  return call.args.every((arg) => !arg.startsWith('-') || /^-[a-zA-Z]+$/u.test(arg));
}

/** This capability is minted by the safety gate, never supplied by model/tool arguments. */
export function isReadOnlyQuery(analysis: CommandAnalysis): boolean {
  return !analysis.hasError && !analysis.hasCompound && !analysis.hasExpansion && !analysis.hasPipeline
    && !analysis.hasRedirection && analysis.calls.length === 1 && isQuery(analysis.calls[0]!);
}

function isLowRiskCommand(analysis: CommandAnalysis, operation: ProposedOperation): boolean {
  if (analysis.hasCompound || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection || analysis.calls.length !== 1) return false;
  const call = analysis.calls[0];
  if (!call) return false;
  if (isQuery(call)) return true;
  if (call.name === 'cd' && call.args.length === 1) {
    const target = literalPath(call.args[0] ?? '', operation.scope.cwd);
    return target !== null && operation.scope.allowedWorkingRoots.some((root) => isInside(target, root));
  }
  if (call.name !== 'mkdir' || call.dynamic || call.redirects) return false;
  const args = call.args.filter((arg) => arg !== '-p' && arg !== '--parents' && arg !== '--');
  if (args.length === 0 || args.some((arg) => arg.startsWith('-'))) return false;
  return args.every((arg) => {
    const target = literalPath(arg, operation.scope.cwd);
    return target !== null
      && operation.scope.allowedWorkingRoots.some((root) => isInside(target, root))
      && !operation.scope.protectedPaths.some((root) => isInside(target, root));
  });
}

export function decideSafety(operation: ProposedOperation, settings: SafetySettings, analysis?: CommandAnalysis): SafetyDecision {
  if (settings.revision !== operation.scope.policyRevision) return decision('error', 'policy-stale', 'Policy changed after this operation was proposed');
  if (operation.kind === 'upload') {
    const localRoot = path.resolve(operation.localRoot);
    const localTarget = path.resolve(operation.localPath);
    const relative = path.relative(localRoot, localTarget);
    if (!path.isAbsolute(operation.localRoot) || !path.isAbsolute(operation.localPath)
      || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return decision('deny', 'local-scope', 'Upload source is outside the user-selected local directory');
    }
  }
  if (operation.kind !== 'command') {
    const target = operation.kind === 'upload' ? operation.remotePath : operation.path;
    if (!literalPath(target, operation.scope.cwd)) return decision('error', 'path-opaque', 'Structured file target is not a literal path');
    const absolute = literalPath(target, operation.scope.cwd)!;
    if (isBlockDevice(absolute) || CRITICAL_FILES.has(absolute)) return decision('deny', 'system-resource', 'Changing disks or essential system files is forbidden');
  }
  if (protectedTarget(operation)) return decision('deny', 'protected-resource', 'Target belongs to a user-protected resource');
  if (operation.kind === 'delete-path') {
    const target = literalPath(operation.path, operation.scope.cwd);
    if (target && CRITICAL_TREES.has(target)) return decision('deny', 'system-tree-delete', 'Deleting a system tree is forbidden');
  }
  if (operation.kind === 'command') {
    if (!analysis) return decision('error', 'analyzer-missing', 'Command analysis unavailable');
    if (analysis.hasError) return decision('error', 'parse-failed', 'Command could not be parsed completely');
    if (protectedCommandTarget(operation, analysis)) return decision('deny', 'protected-resource', 'Command accesses or removes a user-protected resource');
    const hard = hardCommandReason(analysis, operation.scope.cwd);
    if (hard) return decision('deny', 'system-blacklist', hard);
    if (isLowRiskCommand(analysis, operation)) return decision('allow', 'low-risk-command', 'Known low-risk command in the authorized context');
  }
  if (settings.mode === 'ask') return decision('ask', 'manual-mode', 'This operation needs approval');
  if (settings.mode === 'ai-review') return decision('evaluate', 'ai-review-mode', 'This operation needs independent AI review');
  return decision('allow', 'permissive-mode', 'Allowed by the selected review mode');
}
