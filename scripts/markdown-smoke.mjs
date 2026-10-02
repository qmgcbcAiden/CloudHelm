/* global window, navigator, document */
import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const output = path.join(root, '.cache/markdown-smoke');
await mkdir(output, { recursive: true });
const server = await createServer({
  root: path.join(root, 'scripts/markdown-fixture'), configFile: false, cacheDir: path.join(root, '.cache/markdown-smoke-vite'),
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, esbuild: { jsx: 'automatic' },
  resolve: { alias: { react: path.dirname(desktopRequire.resolve('react/package.json')), 'react-dom': path.dirname(desktopRequire.resolve('react-dom/package.json')) } }
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL ? { channel: process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 540, height: 1000 }, colorScheme: 'dark' });
  const errors = [];
  const remoteRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.url().includes('.example.test/')) remoteRequests.push(request.url()); });
  await page.route('**/*.example.test/**', (route) => route.abort());
  await page.addInitScript(() => {
    // Keep the user's real clipboard untouched while testing the copy button's exact payload.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.fixtureCopied = text; } } });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('heading', { name: 'Docker 部署完成' }).waitFor();
  assert.equal(await page.getByRole('table').count(), 1);
  assert.equal(await page.locator('blockquote').count(), 1);
  assert.equal(await page.locator('ul > li').count(), 2);
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.getByRole('link', { name: '不可执行链接' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '访问服务' }).getAttribute('href'), 'https://service.example.test/status');
  assert.equal(await page.getByRole('link', { name: '访问服务' }).getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.getByRole('link', { name: '查看图片：部署示意图' }).getAttribute('href'), 'https://images.example.test/private.png');
  await page.getByRole('button', { name: '复制代码' }).click();
  await page.getByRole('status').filter({ hasText: '代码已复制到剪贴板，不会执行。' }).waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => window.fixtureCopied), 'docker logs --tail 50 demo-service\n');
  assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);
  assert.deepEqual(remoteRequests, []);
  await page.screenshot({ path: path.join(output, 'markdown-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 360, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: path.join(output, 'markdown-light.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Markdown smoke passed: safe GFM, no remote image loading, copy without execution. Screenshots: ${output}`);
} finally { await browser?.close(); await server.close(); }
