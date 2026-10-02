/* global window, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import console from 'node:console';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { checkPrivateKeyPicker } from './private-key-picker-probe.mjs';
import { checkHostConnectionTest } from './host-connection-probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps/desktop');
const desktopRequire = createRequire(path.join(desktop, 'package.json'));
const packaged = process.argv.includes('--packaged');
const suppliedPath = process.argv.find((argument) => argument.startsWith('--executable='))?.slice('--executable='.length);
const executablePath = suppliedPath ?? (packaged
  ? process.platform === 'darwin'
    ? path.join(desktop, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'CloudHelm.app/Contents/MacOS/CloudHelm')
    : process.platform === 'win32'
      ? path.join(desktop, 'dist/win-unpacked/CloudHelm.exe')
      : path.join(desktop, 'dist/linux-unpacked/cloudhelm')
  : desktopRequire('electron'));
await access(executablePath);
const output = path.join(root, '.cache/desktop-smoke', packaged ? 'packaged' : 'built');
await mkdir(output, { recursive: true });
const userData = await mkdtemp(path.join(os.tmpdir(), 'cloudhelm-desktop-smoke-'));
const environment = { ...process.env, CLOUDHELM_USER_DATA: userData };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
let application;
let page;
let stderr = '';

try {
  application = await electron.launch({ executablePath,
    args: packaged ? [] : [path.join(desktop, 'out/main/index.js')], env: environment, timeout: 30_000 });
  application.process().stderr?.on('data', (chunk) => { stderr += String(chunk); });
  page = await application.firstWindow({ timeout: 30_000 });
  const rendererErrors = [];
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor();
  const boundary = await page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot();
    return { hasPreload: typeof window.cloudhelm.startConversation === 'function',
      hasNodeRequire: typeof window.require !== 'undefined', hasProcess: typeof window.process !== 'undefined',
      hostCount: snapshot.hosts.length, conversationCount: snapshot.conversations.length,
      providers: (await window.cloudhelm.listModelProviders()).length };
  });
  assert.equal(boundary.hasPreload, true);
  assert.equal(boundary.hasNodeRequire, false);
  assert.equal(boundary.hasProcess, false);
  assert.equal(boundary.hostCount, 0);
  assert.equal(boundary.conversationCount, 0);
  assert.ok(boundary.providers > 0);
  await checkPrivateKeyPicker(application, page);
  await checkHostConnectionTest(page, path.join(desktop, 'package.json'));
  const runtime = await application.evaluate(async ({ app, safeStorage, utilityProcess }, input) => {
    const appPath = app.getAppPath();
    const grammarPath = input.packaged ? `${process.resourcesPath}/tree-sitter-bash.wasm` : input.grammarPath;
    const available = safeStorage.isEncryptionAvailable();
    const credentialRoundtrip = available && safeStorage.decryptString(safeStorage.encryptString('cloudhelm-smoke-only')) === 'cloudhelm-smoke-only';
    const native = await new Promise((resolve, reject) => {
      const probe = utilityProcess.fork(input.probePath, [appPath, grammarPath], { serviceName: 'CloudHelm smoke dependency probe' });
      const timeout = setTimeout(() => { probe.kill(); reject(new Error('Native/WASM probe timed out')); }, 20_000);
      probe.on('message', (message) => {
        clearTimeout(timeout); probe.kill();
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
      });
      probe.on('exit', (code) => { if (code !== 0) { clearTimeout(timeout); reject(new Error(`Native/WASM probe exited ${code}`)); } });
    });
    return { packaged: app.isPackaged, appPath, native, safeStorageAvailable: available, credentialRoundtrip };
  }, { packaged, grammarPath: path.join(desktop, 'resources/tree-sitter-bash.wasm'), probePath: path.join(root, 'scripts/desktop-probe.mjs') });
  assert.equal(runtime.native.sqliteRoundtrip, true);
  assert.equal(runtime.native.wasmParsed, true);
  if (process.env.CLOUDHELM_EXPECTED_ARCH) assert.equal(runtime.native.architecture, process.env.CLOUDHELM_EXPECTED_ARCH);
  assert.equal(runtime.safeStorageAvailable, true, 'OS credential encryption is unavailable in this environment');
  assert.equal(runtime.credentialRoundtrip, true);
  if (packaged) assert.equal(runtime.packaged, true);
  const databaseBytes = await readFile(path.join(userData, 'cloudhelm.sqlite'));
  assert.equal(databaseBytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.deepEqual(rendererErrors, []);
  assert.doesNotMatch(stderr, /CloudHelm startup failed|NODE_MODULE_VERSION|Cannot find module|ERR_MODULE_NOT_FOUND/u);
  await page.screenshot({ path: path.join(output, 'window.png'), fullPage: true });
  console.log(JSON.stringify({ check: 'desktop-smoke', ...boundary, ...runtime }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  if (stderr) console.error(stderr.slice(-8000));
  throw error;
} finally {
  await application?.close().catch(() => { application.process().kill(); });
  await rm(userData, { recursive: true, force: true });
}
