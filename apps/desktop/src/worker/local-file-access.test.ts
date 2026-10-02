import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalFileAccess } from './local-file-access.js';

describe('user-selected local scope', () => {
  it('reads the selected tree but refuses both traversal and symlinks escaping it', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-local-')));
    const selected = path.join(root, 'selected');
    const outsideDirectory = path.join(root, 'outside');
    const outside = path.join(outsideDirectory, 'private.txt');
    const escape = path.join(selected, 'escape');
    try {
      await mkdir(selected);
      await mkdir(outsideDirectory);
      await writeFile(path.join(selected, 'allowed.txt'), 'allowed');
      await writeFile(outside, 'private');
      await symlink(outsideDirectory, escape, process.platform === 'win32' ? 'junction' : 'dir');
      const access = new LocalFileAccess([{ path: selected, kind: 'directory' }]);
      expect((await access.read(path.join(selected, 'allowed.txt'))).data.toString()).toBe('allowed');
      await expect(access.read(outside)).rejects.toThrow('outside');
      await expect(access.read(path.join(escape, 'private.txt'))).rejects.toThrow('outside');
      await expect(access.read(path.join(selected, '..', 'outside', 'private.txt'))).rejects.toThrow('outside');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
