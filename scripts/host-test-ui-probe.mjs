/* global window */
import assert from 'node:assert/strict';

export async function checkHostTestControls(page, dialog) {
  await page.evaluate(() => {
    window.fixture.originalHostTest = window.cloudhelm.testHostConnection;
    window.cloudhelm.testHostConnection = async (input) => {
      window.fixture.lastHostTest = input;
      return new Promise((resolve) => { window.fixture.resolveHostTest = resolve; });
    };
  });
  const test = dialog.getByRole('button', { name: '测试连接', exact: true });
  await dialog.getByLabel('服务器地址').fill('draft.example.test');
  await test.click();
  await dialog.getByRole('status').filter({ hasText: '正在检查网络' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByLabel('服务器地址').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.fixture.lastHostTest.host.address), 'draft.example.test');
  assert.equal(await page.evaluate(() => window.fixture.savedHost), undefined, 'Testing must not save the draft');
  await page.evaluate(() => window.fixture.resolveHostTest({ status: 'trust-required', requestId: 'test-trust', stage: 'host',
    address: 'draft.example.test', port: 22, fingerprint: 'SHA256:test-server', expiresAt: Date.now() + 120_000 }));
  await dialog.getByRole('group', { name: '核对测试连接的服务器身份' }).waitFor();
  await dialog.getByLabel('账户').fill('different-user');
  assert.equal(await dialog.getByRole('button', { name: '已核对，继续测试' }).count(), 0, 'Editing invalidates the old confirmation');
  await test.click();
  await page.evaluate(() => window.fixture.resolveHostTest({ status: 'trust-required', requestId: 'new-trust', stage: 'host',
    address: 'draft.example.test', port: 22, fingerprint: 'SHA256:test-server', expiresAt: Date.now() + 120_000 }));
  await dialog.getByRole('button', { name: '已核对，继续测试' }).click();
  assert.equal(await page.evaluate(() => window.fixture.lastHostTest.trustRequestId), 'new-trust');
  await page.evaluate(() => window.fixture.resolveHostTest({ status: 'success', latencyMs: 42 }));
  await dialog.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.savedHost), undefined);
  await test.click();
  await page.evaluate(() => window.fixture.resolveHostTest({ status: 'failed', code: 'auth', stage: 'host' }));
  await dialog.getByRole('alert').filter({ hasText: '身份验证未通过' }).waitFor();
  await page.evaluate(() => { window.cloudhelm.testHostConnection = window.fixture.originalHostTest; });
}
