import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const generated = new Set(['node_modules', 'out', 'dist', 'build', 'coverage', 'vendor']);
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.go$|\.snap$|(?:^|-)fixture\.[cm]?[jt]sx?$/u;
const testDirectory = /^(?:tests|__tests__|__mocks__|__snapshots__|fixtures|.+-fixture)$/iu;

/** Keep test-only sources out of production and engineering-script directories. */
export async function findMisplacedTests(root) {
  const misplaced = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative === 'Tests' || entry.name.startsWith('.') || generated.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (testDirectory.test(entry.name)) misplaced.push(`${relative}/`);
        else await visit(absolute);
      } else if (entry.isFile() && testFile.test(entry.name)) misplaced.push(relative);
    }
  }
  await visit(root);
  return misplaced.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const misplaced = await findMisplacedTests(process.cwd());
  if (misplaced.length) {
    for (const file of misplaced) console.error(`测试代码必须位于根目录 Tests/：${file}`);
    process.exitCode = 1;
  } else console.log('测试目录检查通过：测试与专用 fixture 统一位于 Tests/');
}
