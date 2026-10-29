import { checkApprovalContrast } from './check-approval-contrast.mjs';
import { checkMessageReferences } from './check-message-references.mjs';
import { checkRequestBudget } from './check-request-budget.mjs';
import { checkBudgetSwitching } from './check-budget-switching.mjs';
import { checkVerificationChecks } from './check-verification-checks.mjs';
import { checkPrivilegeFeedback } from './check-privilege-feedback.mjs';
import { checkReasoningContent } from './check-reasoning-content.mjs';
import { checkExecutionThinking } from './check-execution-thinking.mjs';
import { checkComposer } from './check-composer.mjs';
/* global window, document, navigator, structuredClone */
import { checkClarification } from './check-clarification.mjs';
import { checkMiddleClick } from './check-middle-click.mjs';
import assert from 'node:assert/strict';
import { checkHostTestControls } from './host-test-ui-probe.mjs';
import { checkConversationTimeline } from './check-conversation-timeline.mjs';
import { checkViewportLayout } from './check-viewport-layout.mjs';
import { checkUserMessageActions } from './check-user-message-actions.mjs';
import { checkMenusAndShortcuts } from './check-menus-shortcuts.mjs';
import { checkTerminalLayout } from './check-terminal-layout.mjs';
import { checkErrorControl } from './check-error-control.mjs';
import { checkTerminalControl } from './check-terminal-control.mjs';
import console from 'node:console';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const output = path.join(root, '.cache/ui-smoke');
await mkdir(output, { recursive: true });
const server = await createServer({
  root: path.join(root, 'Tests/smoke/ui-fixture'), configFile: false, cacheDir: path.join(root, '.cache/ui-smoke-vite'),
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  esbuild: { jsx: 'automatic' },
  resolve: { alias: {
    react: path.dirname(desktopRequire.resolve('react/package.json')),
    'react-dom': path.dirname(desktopRequire.resolve('react-dom/package.json'))
  } }
});
await server.listen();
let browser;
let page;
const calls = () => page.evaluate(() => window.fixture.calls);
const screenshot = (name) => page.screenshot({ path: path.join(output, name), fullPage: true });

async function exerciseErrors() {
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor();
  await page.evaluate(() => {
    window.fixture.restoreErrorMethods = { startConversation: window.cloudhelm.startConversation,
      testModelConnection: window.cloudhelm.testModelConnection, saveModelProfile: window.cloudhelm.saveModelProfile };
    window.cloudhelm.startConversation = async () => { throw new Error("Error invoking remote method 'cloudhelm:start-conversation': Error: 请先配置所选供应商的 API Key"); };
  });
  await page.getByRole('textbox', { name: '给 AI 的消息' }).fill('缺少模型配置时给出可操作提示');
  await page.getByRole('button', { name: '发送消息' }).click();
  const missingKey = page.getByRole('alertdialog', { name: '请先配置模型' });
  await missingKey.waitFor();
  assert.equal(await missingKey.locator('details').getAttribute('open'), null);
  assert.equal((await missingKey.innerText()).includes('Error invoking'), false);
  await screenshot('friendly-model-error.png');
  await missingKey.getByRole('button', { name: '去配置模型' }).click();
  await page.getByRole('heading', { name: '模型设置', exact: true }).waitFor();
  await page.evaluate(() => {
    window.cloudhelm.testModelConnection = async () => { throw new Error("Error invoking remote method 'cloudhelm:test-model': Error: Invalid API key: sk-fixture-never-display-this-key"); };
    window.cloudhelm.saveModelProfile = async () => { throw new Error("Error invoking remote method 'cloudhelm:save-model-profile': Error: OS credential encryption is unavailable; password=fixture-sensitive-answer"); };
  });
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByRole('alert').filter({ hasText: '模型身份验证未通过' }).waitFor();
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  assert.equal((await page.locator('body').innerText()).includes('sk-fixture'), false);
  await page.getByRole('button', { name: '保存为默认' }).click();
  const saveError = page.getByRole('alertdialog', { name: '系统凭据存储暂不可用' });
  await saveError.waitFor();
  await saveError.getByText('查看技术详情', { exact: true }).click();
  assert.equal((await saveError.innerText()).includes('fixture-sensitive'), false);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { window.fixture.copiedDetails = text; }
    } });
  });
  await saveError.getByRole('button', { name: '复制脱敏详情' }).click();
  await saveError.getByText('已复制脱敏详情', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.fixture.copiedDetails)).includes('fixture-sensitive'), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  // Repeated background-style failures should not stack or immediately reopen.
  await page.getByRole('button', { name: '保存为默认' }).click();
  await page.getByRole('alert').filter({ hasText: '系统凭据存储暂不可用' }).waitFor();
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  await page.evaluate(() => Object.assign(window.cloudhelm, window.fixture.restoreErrorMethods));
  await page.getByRole('button', { name: '返回终端' }).click();
}

async function exerciseConversation() {
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor();
  assert.equal(await page.getByText('创建任务').count(), 0);
  assert.equal(await page.getByText('新建任务').count(), 0);
  await page.getByRole('button', { name: /生产服务器 ubuntu@/ }).click();
  await page.getByText('生产服务器 · SSH 终端').waitFor();
  await page.getByRole('textbox', { name: '给 AI 的消息' }).fill('帮我把这个服务装成 Docker 并启动');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByText('正在处理', { exact: true }).first().waitFor();
  assert.equal((await calls()).find((call) => call.kind === 'start').input.hostId, 'prod');
  await page.evaluate(() => window.fixture.inject({ type: 'terminal-state', terminalId: 'agent1', hostId: 'prod', taskId: 'chat2', state: 'agent' }));
  assert.equal(await page.getByText('生产服务器 · SSH 终端').count(), 1);
  await page.evaluate(() => window.fixture.decorate());
  await page.getByText('需要你确认安装系统依赖').waitFor();
  await page.getByText('待批准的完整操作').waitFor();
  await page.getByText('sudo apt-get install -y docker.io', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await checkApprovalContrast(page, output);
  await screenshot('main-dark.png');
  await page.getByRole('button', { name: '批准这次操作' }).click();
  assert.equal((await calls()).find((call) => call.kind === 'approval').approved, true);
  const modelMenuButton = page.getByRole('button', { name: '对话模型' });
  await modelMenuButton.click();
  const modelMenu = page.getByRole('menu', { name: '对话模型' });
  await modelMenu.waitFor();
  await screenshot('model-menu.png');
  // Clicking the trigger again toggles the menu closed instead of reopening it.
  await modelMenuButton.click();
  await modelMenu.waitFor({ state: 'hidden' });
  await modelMenuButton.click();
  await modelMenu.getByRole('menuitem', { name: /Claude Sonnet/ }).click();
  assert.equal((await calls()).find((call) => call.kind === 'model').model.provider, 'anthropic');
  await modelMenuButton.click();
  await page.getByRole('menuitem', { name: '重新应用当前模型的 Key 和地址' }).click();
  assert.equal((await calls()).filter((call) => call.kind === 'model').at(-1).model.provider, 'anthropic');
  await page.getByRole('textbox', { name: '给 AI 的消息' }).fill('草稿不会丢');
  await page.getByRole('button', { name: /开发服务器 deployer@/ }).click();
  assert.equal(await page.getByRole('textbox', { name: '给 AI 的消息' }).textContent(), '');
  await page.getByRole('button', { name: '生产服务器', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '给 AI 的消息' }).textContent(), '草稿不会丢');
}

async function exerciseNavigation() {
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('heading', { name: '远程文件' }).waitFor();
  await page.getByRole('button', { name: '关闭 生产服务器 · 文件' }).click();
  await page.getByRole('button', { name: '生产服务器 更多操作' }).click();
  await page.getByRole('menuitem', { name: '编辑主机', exact: true }).click();
  await page.getByRole('dialog', { name: '编辑 SSH 主机' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '模型设置', exact: true }).waitFor();
  await screenshot('settings.png');
  assert.equal(await page.getByRole('textbox', { name: '给 AI 的消息' }).count(), 0);
  await page.getByRole('tab', { name: 'AI 审核' }).click();
  const reviewTrigger = page.getByRole('button', { name: /审核模型 当前对话模型/ });
  await reviewTrigger.click();
  const reviewMenu = page.getByRole('menu', { name: '审核模型' });
  await reviewMenu.waitFor();
  assert.equal(await reviewMenu.evaluate((element) => window.getComputedStyle(element).backgroundColor), 'rgb(36, 39, 40)');
  await screenshot('review-model-menu.png');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.match(await page.getByRole('button', { name: '审核模型 Jev' }).innerText(), /Jev/u);
  await page.getByRole('button', { name: '审核模型 Jev' }).click();
  await page.getByRole('menu', { name: '审核模型' }).getByRole('menuitem', { name: '当前对话模型（默认）' }).click();
  await page.getByRole('tab', { name: 'API Key' }).click();
  await page.locator('#model-base-url').fill('https://proxy.example.com/v1');
  await page.getByRole('button', { name: '生产服务器', exact: true }).click();
  await page.getByRole('dialog', { name: '还有未保存的更改' }).waitFor();
  await page.getByRole('button', { name: '继续编辑' }).click();
  assert.equal(await page.locator('#model-base-url').inputValue(), 'https://proxy.example.com/v1');
  await page.getByRole('button', { name: '返回终端' }).click();
  await page.getByRole('button', { name: '放弃更改' }).click();
}

async function exerciseInputIsolation() {
  await page.getByRole('button', { name: '生产服务器', exact: true }).click();
  await page.getByRole('button', { name: '打开 AI 专用终端' }).click();
  await page.evaluate(() => window.fixture.inject({ type: 'terminal-data', terminalId: 'agent1', data: '\u001b[6n' }));
  await page.waitForFunction(() => window.fixture.calls.some((call) => call.kind === 'protocol'));
  await page.locator('.xterm-helper-textarea').press('Control+c');
  await page.waitForFunction(() => window.fixture.calls.some((call) => call.kind === 'stop-terminal'));
  await page.locator('.xterm-helper-textarea').pressSequentially('pwd');
  await page.waitForFunction(() => window.fixture.calls.some((call) => call.kind === 'input'));
  const keyboardCalls = await calls();
  assert.ok(keyboardCalls.findIndex((call) => call.kind === 'stop-terminal') < keyboardCalls.findIndex((call) => call.kind === 'input'));
  await page.evaluate(() => window.fixture.running());
  await page.getByRole('button', { name: '关闭 生产服务器 · AI', exact: true }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => window.fixture.addInput());
  await page.getByRole('dialog', { name: '安装 Docker 需要管理员权限' }).waitFor();
  await page.getByLabel('认证信息', { exact: true }).fill('test-sensitive-answer');
  assert.equal(await page.getByRole('checkbox', { name: /这是可复用密码/u }).count(), 0);
  await page.getByRole('button', { name: '安全提交', exact: true }).click();
  assert.deepEqual((await calls()).find((call) => call.kind === 'answer').answer, { action: 'submit', value: 'test-sensitive-answer' });
  assert.equal((await calls()).filter((call) => call.kind === 'input').some((call) => call.data.includes('test-sensitive-answer')), false);
  assert.equal(await page.evaluate(async () => JSON.stringify((await window.cloudhelm.snapshot()).messages).includes('test-sensitive-answer')), false);
  await page.evaluate(() => window.fixture.addInput({ cache: true }));
  const optIn = page.getByRole('checkbox', { name: /这是可复用密码/u });
  await optIn.waitFor(); assert.equal(await optIn.isChecked(), false);
  await page.getByLabel('认证信息', { exact: true }).fill('test-cache-password'); await optIn.check();
  await page.getByRole('button', { name: '安全提交', exact: true }).click();
  assert.deepEqual((await calls()).filter((call) => call.kind === 'answer').at(-1).answer,
    { action: 'submit', value: 'test-cache-password', cacheAsPassword: true });
  await page.evaluate(() => window.fixture.addInput({ cache: true, otp: true }));
  await page.getByLabel('验证码', { exact: true }).fill('123456');
  assert.equal(await page.getByRole('checkbox', { name: /这是可复用密码/u }).count(), 0);
  await page.getByRole('button', { name: '安全提交', exact: true }).click();
  assert.deepEqual((await calls()).filter((call) => call.kind === 'answer').at(-1).answer, { action: 'submit', value: '123456' });
  assert.equal(await page.evaluate(async () => JSON.stringify((await window.cloudhelm.snapshot()).messages).includes('test-cache-password')), false);
}

async function exerciseAsyncErrors() {
  // The main process projects task-status into snapshots before renderer delivery.
  // Introducing a historical failure must not be mistaken for a fresh failure.
  await page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot();
    snapshot.conversations.push({ ...snapshot.conversations[0], id: 'historical-failure', goal: '曾经失败的历史对话',
      status: 'failed', summary: 'Error: Unauthorized; password=history-secret-never-render', createdAt: 1, updatedAt: 1 });
    window.fixture.asyncErrorSnapshot = snapshot;
    window.fixture.inject({ type: 'snapshot', value: snapshot });
  });
  await page.getByRole('button', { name: /曾经失败的历史对话/ }).click();
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  await page.getByText('模型身份验证未通过', { exact: true }).waitFor();
  await page.getByText('查看错误详情', { exact: true }).click();
  assert.equal((await page.locator('body').textContent()).includes('history-secret-never-render'), false);
  await page.getByRole('button', { name: '查看对话记录', exact: true }).click();
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  assert.equal((await page.locator('body').textContent()).includes('history-secret-never-render'), false);
  // A newly delivered failure of the running conversation does notify the user.
  await page.evaluate(() => {
    const snapshot = structuredClone(window.fixture.asyncErrorSnapshot);
    snapshot.conversations[0].status = 'failed';
    snapshot.conversations[0].summary = 'Error: Host is not connected; apiKey=async-secret-never-render';
    window.fixture.asyncErrorSnapshot = snapshot;
    window.fixture.inject({ type: 'snapshot', value: snapshot });
  });
  const failure = page.getByRole('alertdialog', { name: 'SSH 连接已断开' });
  await failure.waitFor();
  await failure.getByText('查看技术详情', { exact: true }).click();
  assert.equal((await page.locator('body').textContent()).includes('async-secret-never-render'), false);
  await failure.getByRole('button', { name: '知道了' }).click();
  await page.evaluate(() => window.fixture.inject({ type: 'snapshot', value: structuredClone(window.fixture.asyncErrorSnapshot) }));
  await page.getByRole('button', { name: /帮我把这个服务装成 Docker 并启动/ }).click();
  await page.getByText('SSH 连接已断开', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  assert.equal((await page.locator('body').textContent()).includes('async-secret-never-render'), false);
  // Successful reports containing diagnostic words are ordinary content.
  await page.evaluate(() => {
    const snapshot = structuredClone(window.fixture.asyncErrorSnapshot);
    snapshot.conversations[0].status = 'ready-for-review';
    snapshot.conversations[0].summary = '已经完成 Unauthorized 错误排查。';
    snapshot.conversations[0].report = { summary: '已经完成 Unauthorized 错误排查，服务正常。', access: [], evidenceOperationIds: [], changes: [], recovery: [] };
    window.fixture.inject({ type: 'snapshot', value: snapshot });
  });
  await page.getByText('已经完成 Unauthorized 错误排查，服务正常。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alertdialog').count(), 0);
}

async function exerciseHostControls() {
  await page.getByRole('button', { name: '生产服务器 更多操作' }).waitFor();
  await page.evaluate(async () => {
    window.fixture.originalHostSnapshot = await window.cloudhelm.snapshot();
    const singleHost = structuredClone(window.fixture.originalHostSnapshot);
    singleHost.hosts = singleHost.hosts.slice(0, 1);
    window.fixture.inject({ type: 'snapshot', value: singleHost });
    window.fixture.originalPickKey = window.cloudhelm.selectPrivateKey;
    window.fixture.originalEditHost = window.cloudhelm.editHost;
    window.cloudhelm.editHost = async (id, draft) => { window.fixture.savedHost = { id, draft }; };
  });
  const trigger = page.getByRole('button', { name: '生产服务器 更多操作' });
  await trigger.click();
  const menu = page.getByRole('menu', { name: '生产服务器 主机操作' });
  await menu.waitFor();
  assert.equal(await menu.getByRole('menuitem').count(), 5);
  assert.equal(await menu.getByRole('menuitem').evaluateAll((items) => items.every((item) => {
    const bounds = item.getBoundingClientRect();
    return item.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })), true, 'All menu actions must be hit-testable beyond the short host list');
  await screenshot('host-menu-dark.png');
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('menuitem', { name: '移除主机' }).evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.getByRole('alertdialog', { name: '移除 生产服务器？' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await trigger.click();
  await menu.waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
  await trigger.click();
  await menu.waitFor();
  await page.getByRole('heading', { name: '你的服务器，随时连接' }).click();
  await menu.waitFor({ state: 'detached' });
  await trigger.click();
  await page.getByRole('menuitem', { name: '编辑主机' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑 SSH 主机' });
  await dialog.getByLabel('认证方式').selectOption('private-key');
  const keyPath = dialog.getByLabel('私钥路径');
  await keyPath.fill('/Users/demo/.ssh/original');
  await dialog.getByRole('button', { name: '选择文件' }).click();
  await page.waitForFunction(() => document.getElementById('private-key-path').value === '/Users/demo/.ssh/server key');
  assert.equal(await page.evaluate(() => window.fixture.savedHost), undefined, 'Picking a key must not save the host automatically');
  await page.evaluate(() => { window.cloudhelm.selectPrivateKey = async () => null; });
  await dialog.getByRole('button', { name: '选择文件' }).click();
  await dialog.getByRole('button', { name: '选择文件' }).waitFor();
  assert.equal(await keyPath.inputValue(), '/Users/demo/.ssh/server key', 'Cancel must preserve the selected path');
  await checkHostTestControls(page, dialog);
  await screenshot('host-private-key-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 980, height: 640 });
  await keyPath.scrollIntoViewIfNeeded();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 980 && bounds.y + bounds.height <= 640);
  assert.equal(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth), false);
  assert.equal(await dialog.getByRole('button', { name: '测试连接', exact: true }).evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  }), true, 'Test connection remains visible at the bottom of a small window');
  await screenshot('host-private-key-light-small.png');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.fixture.savedHost.draft.privateKeyPath), '/Users/demo/.ssh/server key');
  await dialog.waitFor({ state: 'detached' });
  await page.evaluate(() => {
    window.cloudhelm.selectPrivateKey = window.fixture.originalPickKey;
    window.cloudhelm.editHost = window.fixture.originalEditHost;
    window.fixture.inject({ type: 'snapshot', value: window.fixture.originalHostSnapshot });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL ? { channel: process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark',
    deviceScaleFactor: Number(process.env.CLOUDHELM_SMOKE_DEVICE_SCALE_FACTOR ?? 1) });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await checkBudgetSwitching(page, screenshot);
  await exerciseHostControls();
  await exerciseErrors();
  await exerciseConversation();
  await checkComposer(page, screenshot);
  await checkConversationTimeline(page, screenshot);
  await checkViewportLayout(page, screenshot);
  await checkUserMessageActions(page, screenshot);
  await checkMenusAndShortcuts(page, screenshot);
  await checkTerminalLayout(page, screenshot);
  await exerciseNavigation();
  await exerciseInputIsolation();
  await page.getByRole('button', { name: '生产服务器', exact: true }).click();
  await page.getByRole('button', { name: '关闭 生产服务器', exact: true }).click();
  assert.equal((await calls()).filter((call) => call.kind === 'close').length, 1);
  await page.emulateMedia({ colorScheme: 'light' });
  await screenshot('main-light.png');
  await page.setViewportSize({ width: 980, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await screenshot('main-minimum-width.png');
  await exerciseAsyncErrors();
  await checkErrorControl(page, screenshot);
  await checkExecutionThinking(page, screenshot);
  await checkMessageReferences(page, screenshot);
  await checkReasoningContent(page, screenshot);
  await checkTerminalControl(page, screenshot);
  await checkMiddleClick(page, screenshot);
  await checkClarification(page, screenshot);
  await checkVerificationChecks(page, screenshot);
  await checkPrivilegeFeedback(page, screenshot);
  await checkRequestBudget(page, screenshot);
  assert.deepEqual(errors, []);
  console.log(`UI smoke passed. Fake SSH/models only; screenshots: ${output}`);
} catch (error) {
  if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
