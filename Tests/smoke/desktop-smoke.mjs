import { verifyNativeBundle } from '../../scripts/verify-native-helper.mjs';
/* global window, Buffer, setTimeout, clearTimeout */
import { checkClarificationRuntime } from './check-clarification-runtime.mjs';
import assert from 'node:assert/strict';
import console from 'node:console';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { checkPrivateKeyPicker } from './private-key-picker-probe.mjs';
import { checkHostConnectionTest } from './host-connection-probe.mjs';
import { DesktopProcess, cleanupDesktopSmoke, withTimeout } from './desktop-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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
const instances = new Set();
let currentProcess;

// locator.waitFor() defaults to no timeout and evaluate() never times out. Bound every
// renderer wait and smoke stage so a stalled Electron fails with diagnostics instead of
// hanging until the CI job timeout cancels the failure artifacts.
const waitReady = (target) => target.getByRole('textbox', { name: '给 AI 的消息' }).waitFor({ timeout: 60_000 });

async function launch() {
  application = await electron.launch({ executablePath,
    args: packaged ? [] : [path.join(desktop, 'out/main/index.js')], env: environment, timeout: 30_000 });
  currentProcess = new DesktopProcess(application);
  instances.add(currentProcess);
  application.process().stderr?.on('data', (chunk) => { stderr += String(chunk); });
  // Retain descendants for cleanup even if firstWindow fails and the main process exits.
  await currentProcess.capture();
  page = await application.firstWindow({ timeout: 30_000 });
  await currentProcess.capture();
  return page;
}

try {
  page = await launch();
  const rendererErrors = [];
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await waitReady(page);
  const boundary = await withTimeout(() => page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot();
    return { hasPreload: typeof window.cloudhelm.startConversation === 'function',
      hasNodeRequire: typeof window.require !== 'undefined', hasProcess: typeof window.process !== 'undefined',
      hostCount: snapshot.hosts.length, conversationCount: snapshot.conversations.length,
      providers: (await window.cloudhelm.listModelProviders()).length };
  }), 60_000, 'Renderer boundary probe');
  assert.equal(boundary.hasPreload, true);
  assert.equal(boundary.hasNodeRequire, false);
  assert.equal(boundary.hasProcess, false);
  assert.equal(boundary.hostCount, 0);
  assert.equal(boundary.conversationCount, 0);
  assert.ok(boundary.providers > 0);
  await withTimeout(() => checkPrivateKeyPicker(application, page), 60_000, 'Private key picker probe');
  await withTimeout(() => checkHostConnectionTest(page, path.join(desktop, 'package.json')), 120_000, 'Host connection probe');
  // utilityProcess.fork only accepts string arguments; the packaged run passes an empty
  // bundle directory and the probe then skips its shared-chunk analyzer import.
  const runtime = await withTimeout(() => application.evaluate(async ({ app, safeStorage, utilityProcess }, input) => {
    const appPath = app.getAppPath();
    const grammarPath = input.packaged ? `${process.resourcesPath}/tree-sitter-bash.wasm` : input.grammarPath;
    const available = safeStorage.isEncryptionAvailable();
    const credentialRoundtrip = available && safeStorage.decryptString(safeStorage.encryptString('cloudhelm-smoke-only')) === 'cloudhelm-smoke-only';
    const native = await new Promise((resolve, reject) => {
      const probe = utilityProcess.fork(input.probePath, [appPath, grammarPath, input.bundleDirectory], { serviceName: 'CloudHelm smoke dependency probe' });
      const timeout = setTimeout(() => { probe.kill(); reject(new Error('Native/WASM probe timed out')); }, 20_000);
      probe.on('message', (message) => {
        clearTimeout(timeout); probe.kill();
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
      });
      probe.on('exit', (code) => { if (code !== 0) { clearTimeout(timeout); reject(new Error(`Native/WASM probe exited ${code}`)); } });
    });
    return { packaged: app.isPackaged, appPath, native, remoteNativePath: input.packaged ? `${process.resourcesPath}/native` : input.remoteNativePath, safeStorageAvailable: available, credentialRoundtrip };
  }, { packaged, grammarPath: path.join(desktop, 'resources/tree-sitter-bash.wasm'), remoteNativePath: path.join(desktop, 'resources/native'),
    probePath: path.join(root, 'Tests/smoke/desktop-probe.mjs'), bundleDirectory: packaged ? '' : path.join(desktop, 'out/main') }),
  60_000, 'Native/WASM and credential probe');
  await verifyNativeBundle(runtime.remoteNativePath);
  assert.equal(runtime.native.sqliteRoundtrip, true);
  assert.equal(runtime.native.wasmParsed, true);
  if (!packaged) {
    // Unpackaged runs cannot reach the adapter's grammar package, so the build must ship the grammar
    // beside the bundle and the app's own analyzer must resolve it there.
    await access(path.join(desktop, 'out/main/tree-sitter-bash.wasm'));
    assert.equal(runtime.native.appAnalyzer?.calls, 3);
    assert.equal(runtime.native.appAnalyzer?.compound, true);
  }
  if (process.env.CLOUDHELM_EXPECTED_ARCH) assert.equal(runtime.native.architecture, process.env.CLOUDHELM_EXPECTED_ARCH);
  assert.equal(runtime.safeStorageAvailable, true, 'OS credential encryption is unavailable in this environment');
  assert.equal(runtime.credentialRoundtrip, true);
  if (packaged) assert.equal(runtime.packaged, true);
  if (process.platform === 'win32') {
    // A brand-new Chromium profile persists its Windows encryption key on clean shutdown.
    // Prime that profile before saving the model fixture's credential and crash-testing a task.
    const encrypted = await withTimeout(
      () => application.evaluate(({ safeStorage }) => safeStorage.encryptString('cloudhelm-smoke-bootstrap').toString('base64')),
      30_000, 'Windows profile encryption priming');
    await currentProcess.close();
    instances.delete(currentProcess);
    page = await launch();
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    await waitReady(page);
    const decrypted = await withTimeout(
      () => application.evaluate(({ safeStorage }, value) => safeStorage.decryptString(Buffer.from(value, 'base64')), encrypted),
      30_000, 'Windows profile decryption check');
    assert.equal(decrypted, 'cloudhelm-smoke-bootstrap', 'Windows profile encryption must survive restart before crash testing');
  }
  page = await withTimeout(() => checkClarificationRuntime(page, async () => {
    // Crash only this isolated smoke-test instance, preserving its temporary database.
    await currentProcess.crash();
    instances.delete(currentProcess);
    const next = await launch();
    next.on('pageerror', (error) => rendererErrors.push(error.message));
    await waitReady(next);
    return next;
  }), 180_000, 'Clarification runtime probe');
  const databaseBytes = await readFile(path.join(userData, 'cloudhelm.sqlite'));
  assert.equal(databaseBytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.deepEqual(rendererErrors, []);
  assert.doesNotMatch(stderr, /CloudHelm startup failed|NODE_MODULE_VERSION|Cannot find module|ERR_MODULE_NOT_FOUND/u);
  await page.screenshot({ path: path.join(output, 'window.png'), fullPage: true });
  // before-quit can repeat or be canceled by window handlers. SQLite must remain open until will-quit.
  await application.evaluate(({ app }) => {
    app.emit('before-quit', { preventDefault() {} });
    app.emit('before-quit', { preventDefault() {} });
  });
  const afterCanceledQuit = await withTimeout(() => page.evaluate(() => window.cloudhelm.snapshot()), 30_000, 'Snapshot after canceled quit');
  assert.ok(afterCanceledQuit.profile, 'Application state must remain readable after a canceled/repeated quit');
  console.log(JSON.stringify({ check: 'desktop-smoke', ...boundary, ...runtime }, null, 2));
} catch (error) {
  // Print the original failure before diagnostics or cleanup can fail themselves.
  console.error(error);
  process.exitCode = 1;
  if (page && !page.isClosed()) await withTimeout(() => page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 5_000 }), 6_000, 'Failure screenshot').catch(() => {});
  if (stderr) console.error(stderr.slice(-8000));
  await writeFile(path.join(output, 'failure.log'), `${error instanceof Error ? error.stack : String(error)}\n${stderr}`)
    .catch((failure) => console.warn('Could not write smoke failure log', failure));
} finally {
  await cleanupDesktopSmoke(instances, userData, (message, error) => {
    console.warn(message, error);
    process.exitCode = 1;
  });
}
// A failed Playwright transport must not keep this CLI alive after bounded cleanup.
process.exit(process.exitCode ?? 0);
