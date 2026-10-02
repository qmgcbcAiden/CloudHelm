/* global window */
import assert from 'node:assert/strict';

/** Exercise the real preload/main IPC with an isolated, stubbed native dialog. */
export async function checkPrivateKeyPicker(application, page) {
  await application.evaluate(({ dialog }) => {
    const probe = { original: dialog.showOpenDialog, calls: [], results: [
      { canceled: true, filePaths: ['/fixture/ignored'] },
      { canceled: false, filePaths: ['/fixture/.ssh/server key'] },
      { canceled: false, filePaths: [] }
    ] };
    globalThis.cloudhelmPickerProbe = probe;
    dialog.showOpenDialog = async (...args) => {
      probe.calls.push({ hasParent: args.length === 2, options: args.at(-1) });
      return probe.results.shift();
    };
  });
  try {
    const values = await page.evaluate(async () => [
      await window.cloudhelm.selectPrivateKey(),
      await window.cloudhelm.selectPrivateKey(),
      await window.cloudhelm.selectPrivateKey()
    ]);
    assert.deepEqual(values, [null, '/fixture/.ssh/server key', null]);
    const calls = await application.evaluate(() => globalThis.cloudhelmPickerProbe.calls);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.hasParent, true);
      assert.equal(call.options.title, '选择 SSH 私钥');
      assert.deepEqual(call.options.properties, ['openFile', 'showHiddenFiles', 'dontAddToRecent']);
      assert.match(call.options.defaultPath, /[/\\]\.ssh$/u);
    }
    const snapshot = await page.evaluate(() => window.cloudhelm.snapshot());
    assert.equal(snapshot.hosts.length, 0);
    assert.equal(snapshot.conversations.length, 0);
  } finally {
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.cloudhelmPickerProbe.original;
      delete globalThis.cloudhelmPickerProbe;
    });
  }
}
