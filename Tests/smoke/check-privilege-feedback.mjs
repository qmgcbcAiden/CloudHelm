/* global window, structuredClone */
import assert from 'node:assert/strict';

export async function checkPrivilegeFeedback(page, screenshot) {
  await page.reload(); await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor();
  await page.evaluate(async () => {
    const task = await window.cloudhelm.startConversation({ hostId: 'prod', message: '提权反馈回归',
      model: { provider: 'openai', modelId: 'gpt-5.4' }, localSelectionTokens: [] });
    const snapshot = await window.cloudhelm.snapshot(); const current = snapshot.conversations.find((item) => item.id === task.id);
    current.status = 'paused'; current.resumeReason = 'interrupted'; current.summary = 'sudo 授权受限，请明确继续，不自动换身份。';
    snapshot.execution = { [task.id]: { model: 'idle', remote: 'idle', stopping: false, canStop: false } };
    snapshot.operations.push({ id: 'sudo-feedback-op', taskId: task.id, hostId: 'prod', kind: 'command', preview: 'sudo -- stat /root/fixture',
      status: 'failed', exitCode: 1, readOnly: true, effects: 'none', createdAt: Date.now(),
      privilege: { method: 'sudo', stage: 'authorization', code: 'authorization-denied', source: 'output-inference', businessCommand: 'unknown', recovery: 'confirm-alternative' } });
    window.fixture.privilegeSnapshot = snapshot; window.fixture.privilegeTaskId = task.id;
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await page.getByRole('button', { name: /提权反馈回归/u }).click();
  const panel = page.locator('aside[class*="agentPanel"]');
  const feedback = panel.getByRole('status', { name: '提权处理结果' }); await feedback.waitFor();
  await feedback.getByText('sudo · sudo 授权受限', { exact: true }).waitFor();
  await feedback.getByText(/此分类来自输出推断/u).waitFor();
  assert.equal(await panel.getByRole('button', { name: '继续 AI', exact: true }).count(), 1);
  assert.equal((await windowCalls(page)).some((call) => call.kind === 'resume'), false);
  await screenshot('privilege-feedback-paused-dark.png');
  await page.emulateMedia({ colorScheme: 'light' }); await screenshot('privilege-feedback-paused-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => {
    const snapshot = window.fixture.privilegeSnapshot, taskId = window.fixture.privilegeTaskId;
    snapshot.conversations.find((item) => item.id === taskId).status = 'running';
    snapshot.inputs = [{ id: 'privilege-choice', taskId, hostId: 'prod', operationId: 'prepare-only', kind: 'confirmation',
      title: '确认提权方式（默认 sudo）', explanation: '直接su通常需要root密码，不是登录用户的sudo密码；不知道root密码请选择sudo或取消。',
      choices: ['使用 sudo（推荐）', 'SSH 登录 root', '通过 su 切换 root'], expiresAt: Date.now() + 60000 }];
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  const form = panel.locator('form').filter({ hasText: '确认提权方式（默认 sudo）' }); await form.waitFor();
  assert.deepEqual((await form.getByRole('button').allTextContents()).slice(0, 3).map((text) => text.trim()), ['使用 sudo（推荐）', 'SSH 登录 root', '通过 su 切换 root']);
  await form.getByText(/直接su通常需要root密码/u).waitFor(); await screenshot('privilege-sudo-default-choice.png');
  await form.getByRole('button', { name: '使用 sudo（推荐）', exact: true }).click();
  assert.ok((await windowCalls(page)).some((call) => call.kind === 'answer' && call.id === 'privilege-choice'
    && call.answer?.action === 'submit' && call.answer.value === '使用 sudo（推荐）' && call.answer.cacheAsPassword === undefined));
  await page.reload();
}
function windowCalls(page) { return page.evaluate(() => window.fixture.calls); }
