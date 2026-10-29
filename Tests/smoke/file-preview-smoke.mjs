/* global window, document */
import assert from 'node:assert/strict';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const output = path.join(root, '.cache/file-preview-smoke'); await mkdir(output, { recursive: true });
const server = await createServer({ root: path.join(root, 'Tests/smoke/ui-fixture'), configFile: false,
  cacheDir: path.join(root, '.cache/file-preview-smoke-vite'), server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  esbuild: { jsx: 'automatic' }, resolve: { alias: {
    electron: path.join(root, 'Tests/smoke/file-preview-fixture/electron.ts'),
    react: path.dirname(desktopRequire.resolve('react/package.json')), 'react-dom': path.dirname(desktopRequire.resolve('react-dom/package.json'))
  } } });
await server.listen();
const { createFilePreviewStore, registerFilePreviewIpc, registerApprovalIpc } = await server.ssrLoadModule(path.join(root, 'apps/desktop/src/main/file-preview-ipc.ts'));
const { handlers } = await server.ssrLoadModule(path.join(root, 'Tests/smoke/file-preview-fixture/electron.ts'));
let now = Date.now(); let authoritative; const calls = [];
const mainState = { snapshot: () => authoritative };
const previews = createFilePreviewStore(mainState, () => now);
registerFilePreviewIpc(previews);
registerApprovalIpc(mainState, { call: async (call) => { calls.push(call); } }, previews);
const before = 'setting=old\n<script>window.previewExecuted=true</script>\n' + 'unchanged setting\n'.repeat(1200) + 'OLD_COMPLETE_END';
const after = 'setting=new\n<script>window.previewExecuted=true</script>\n' + 'unchanged setting\n'.repeat(1200) + 'NEW_COMPLETE_END';
const hash = (text) => createHash('sha256').update(text).digest('hex');
let browser; let page;
const screenshot = (name) => page.screenshot({ path: path.join(output, name), fullPage: true });
function publish(operationId, taskId) {
  assert.equal(previews.put({ operationId, taskId, hostId: 'prod', transactionId: `txn-${operationId}`,
    preview: { path: '/srv/config', before, after, beforeSha256: hash(before), afterSha256: hash(after), encoding: 'utf8', metadata: '保留 uid=1000、gid=1000、mode=640' } }), true);
}
function operation(id, taskId, status = 'succeeded') {
  return { id, taskId, hostId: 'prod', kind: 'write-file', preview: `写入文件 /srv/config · ${id}`, status,
    fileTransactionId: `txn-${id}`, createdAt: now, runAs: 'user', loginAs: 'user' };
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL ? { channel: process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: new Date(now) });
  await page.exposeFunction('filePreviewIpcInvoke', (method, ...args) => {
    const handler = handlers.get(method); assert.ok(handler, `Missing real Main handler: ${method}`);
    return handler({}, ...args);
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor();
  const taskId = await page.evaluate(async () => {
    const original = window.cloudhelm.decideApproval;
    window.cloudhelm.readFilePreview = (id) => window.filePreviewIpcInvoke('cloudhelm:read-file-preview', id);
    window.cloudhelm.decideApproval = async (id, approved) => { await window.filePreviewIpcInvoke('cloudhelm:decide-approval', id, approved); await original(id, approved); };
    return (await window.cloudhelm.startConversation({ hostId: 'prod', message: '完整文件预览浏览器回归',
      model: { provider: 'openai', modelId: 'gpt-5.4' }, localSelectionTokens: [] })).id;
  });
  authoritative = await page.evaluate(() => window.cloudhelm.snapshot());
  authoritative.operations = [operation('automatic', taskId)]; publish('automatic', taskId);
  await page.evaluate((snapshot) => window.fixture.inject({ type: 'snapshot', value: snapshot }), authoritative);
  await page.getByRole('button', { name: /完整文件预览浏览器回归/u }).click();
  await page.getByText('已完成文件操作', { exact: true }).click();
  const panel = page.locator('aside[class*="agentPanel"]');
  assert.equal((await panel.innerText()).includes('OLD_COMPLETE_END'), false);
  await panel.getByRole('button', { name: '查看完整文件变更', exact: true }).click();
  const content = panel.locator('section[aria-label="文件内容审核"]'); await content.waitFor();
  const diff = content.locator('section[aria-label="文件行差异"]');
  assert.match(await diff.innerText(), /− setting=old/u); assert.match(await diff.innerText(), /\+ setting=new/u);
  await diff.scrollIntoViewIfNeeded(); await screenshot('bounded-line-diff.png');
  assert.equal(await content.locator('script').count(), 0); assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
  assert.ok((await content.locator('details').first().locator('pre').textContent()).length < before.length);
  await content.getByRole('button', { name: '展开完整内容以便审核' }).click();
  assert.equal(await content.locator('details').first().locator('pre').textContent(), before);
  assert.equal(await content.locator('details').nth(1).locator('pre').textContent(), after);
  assert.equal(JSON.stringify(authoritative).includes('OLD_COMPLETE_END'), false);
  assert.equal(await page.evaluate(async () => JSON.stringify(await window.cloudhelm.snapshot()).includes('OLD_COMPLETE_END')), false);
  await screenshot('automatic-full-preview.png');

  for (const id of ['approved', 'expired']) {
    authoritative.operations = [operation(id, taskId, 'proposed')];
    authoritative.approvals = [{ id: `approval-${id}`, taskId, hostId: 'prod', operationId: id, filePreviewOperationId: id,
      fingerprint: 'fixture', title: '文件变更审批', explanation: '检查完整新旧内容', preview: '写入 /srv/config', expiresAt: now + 60 * 60_000 }];
    publish(id, taskId);
    await page.evaluate((snapshot) => window.fixture.inject({ type: 'snapshot', value: snapshot }), authoritative);
    const approval = panel.locator('section[aria-label="命令审批"]'); await approval.waitFor();
    await approval.locator('section[aria-label="文件内容审核"]').waitFor();
    await approval.getByRole('button', { name: '展开完整内容以便审核' }).click();
    assert.equal(await approval.locator('details').first().locator('pre').textContent(), before);
    const approve = approval.getByRole('button', { name: '批准这次操作', exact: true });
    assert.equal(await approve.isEnabled(), true);
    if (id === 'approved') {
      await screenshot('approval-private-preview.png'); await approve.click();
      assert.ok(calls.some((call) => call.approvalId === 'approval-approved' && call.approved));
    } else {
      now += 16 * 60_000; await page.clock.fastForward(16 * 60_000);
      await approval.getByText(/完整预览已过期或不可用/u).waitFor(); assert.equal(await approve.isDisabled(), true);
      const rejected = await page.evaluate(async () => { try { await window.cloudhelm.decideApproval('approval-expired', true); return false; } catch { return true; } });
      assert.equal(rejected, true); assert.equal(calls.some((call) => call.approvalId === 'approval-expired' && call.approved), false);
      assert.equal((await approval.innerText()).includes('OLD_COMPLETE_END'), false);
      await screenshot('expired-preview-blocked.png');
      await approval.getByRole('button', { name: '拒绝', exact: true }).click();
      assert.ok(calls.some((call) => call.approvalId === 'approval-expired' && !call.approved));
    }
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  console.log(`File preview browser smoke passed with real Main private IPC handlers and memory store; no SSH/models. Screenshots: ${output}`);
} catch (error) {
  if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {});
  throw error;
} finally { previews.clear(); await browser?.close(); await server.close(); }
