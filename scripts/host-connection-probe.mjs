/* global window */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';

/** Exercise preload → main → utility process with a disposable loopback SSH server. */
export async function checkHostConnectionTest(page, desktopPackagePath) {
  const { Server } = createRequire(desktopPackagePath)('ssh2');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  let sessions = 0;
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (request) => {
      if (request.method === 'password' && request.username === 'probe' && request.password === 'synthetic-probe-only') request.accept();
      else request.reject(['password']);
    });
    client.on('session', (_accept, reject) => { sessions += 1; reject(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const input = { host: { label: 'Unsaved connection probe', address: '127.0.0.1', port: server.address().port, username: 'probe', auth: 'password' },
      secret: 'synthetic-probe-only' };
    const before = await page.evaluate(() => window.cloudhelm.snapshot());
    const first = await page.evaluate((draft) => window.cloudhelm.testHostConnection(draft), input);
    assert.equal(first.status, 'trust-required');
    assert.match(first.fingerprint, /^SHA256:/u);
    const result = await page.evaluate((draft) => window.cloudhelm.testHostConnection(draft), { ...input, trustRequestId: first.requestId });
    assert.equal(result.status, 'success');
    const after = await page.evaluate(() => window.cloudhelm.snapshot());
    assert.deepEqual(after.hosts, before.hosts, 'Testing must not save a host or update its status');
    assert.deepEqual(after.terminals, before.terminals, 'Testing must not open a terminal');
    assert.equal(sessions, 0, 'Testing must not open a shell or execute commands');
    // Trust is single-use and is not silently persisted by successful testing.
    const again = await page.evaluate((draft) => window.cloudhelm.testHostConnection(draft), input);
    assert.equal(again.status, 'trust-required');
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
