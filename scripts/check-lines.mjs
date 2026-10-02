import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(entries.map(async (entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(name) : /\.(?:ts|tsx|css|mjs|cjs)$/u.test(entry.name) ? [name] : [];
  }));
  return found.flat();
}

const files = [...await sourceFiles('apps'), ...await sourceFiles('packages'), ...await sourceFiles('scripts')];
let failures = 0;
for (const file of files) {
  const count = (await readFile(file, 'utf8')).split('\n').length;
  if (count > 800) { console.error(`${file}: ${count} lines (limit 800)`); failures++; }
}
if (failures) process.exitCode = 1;
