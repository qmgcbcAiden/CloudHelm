// Runs under the launched Electron app's utility process and resolves that app's
// own packaged dependencies, so system Node cannot hide an Electron ABI mismatch.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
const appRequire = createRequire(path.join(process.argv[2], 'package.json'));

async function probe() {
  const Database = appRequire('better-sqlite3');
  const database = new Database(':memory:');
  database.exec('CREATE TABLE smoke (value TEXT NOT NULL)');
  database.prepare('INSERT INTO smoke VALUES (?)').run('cloudhelm-desktop-smoke');
  const sqliteRoundtrip = database.prepare('SELECT value FROM smoke').get().value === 'cloudhelm-desktop-smoke';
  const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
  database.close();
  const grammarPath = process.argv[3];
  if (!existsSync(grammarPath)) throw new Error(`Bundled Bash grammar is missing: ${grammarPath}`);
  const { Parser, Language } = appRequire('web-tree-sitter');
  await Parser.init();
  const language = await Language.load(grammarPath);
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse('printf "%s\\n" cloudhelm');
  const wasmParsed = !!tree && !tree.rootNode.hasError && tree.rootNode.type === 'program';
  tree?.delete(); parser.delete();
  return { sqliteRoundtrip, sqliteVersion, wasmParsed, grammarPath, electron: process.versions.electron, architecture: process.arch };
}
probe().then(
  (result) => process.parentPort.postMessage({ result }),
  (error) => process.parentPort.postMessage({ error: error instanceof Error ? error.stack : String(error) })
);
