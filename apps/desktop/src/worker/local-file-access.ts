import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LocalScope } from '@cloudhelm/contracts';

const MAX_LOCAL_BYTES = 1_048_576;

function inside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function checkedPath(scope: LocalScope, requested: string): Promise<string> {
  if (!path.isAbsolute(requested)) throw new Error('Use an absolute local path from the selected scope');
  const actualRoot = await realpath(scope.path);
  if (actualRoot !== scope.path) throw new Error('The selected local source changed; select it again');
  const actualTarget = await realpath(requested);
  if (scope.kind === 'file' ? actualTarget !== actualRoot : !inside(actualTarget, actualRoot)) {
    throw new Error('Local path is outside the selected source');
  }
  return actualTarget;
}

export class LocalFileAccess {
  constructor(private readonly scopes: LocalScope[]) {}

  findScope(requested: string): LocalScope | undefined {
    return this.scopes.find((scope) => scope.kind === 'file' ? requested === scope.path : inside(requested, scope.path));
  }

  async read(requested: string): Promise<{ data: Buffer; scope: LocalScope }> {
    const scope = this.findScope(requested);
    if (!scope) throw new Error('File is outside the selected local sources');
    const actual = await checkedPath(scope, requested);
    const metadata = await stat(actual);
    if (!metadata.isFile() || metadata.size > MAX_LOCAL_BYTES) throw new Error('Only regular local files up to 1 MiB are supported');
    return { data: await readFile(actual), scope };
  }

  async list(requested: string): Promise<Array<{ name: string; kind: 'file' | 'directory' | 'other'; size: number }>> {
    const scope = this.findScope(requested);
    if (!scope || scope.kind !== 'directory') throw new Error('Directory is outside the selected local sources');
    const actual = await checkedPath(scope, requested);
    const entries = await readdir(actual, { withFileTypes: true });
    return entries.slice(0, 200).map((entry) => ({ name: entry.name,
      kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other', size: 0 }));
  }
}
