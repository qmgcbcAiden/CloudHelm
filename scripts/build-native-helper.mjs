import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = path.join(root, '.cache/toolchain/go/bin', process.platform === 'win32' ? 'go.exe' : 'go');
const go = process.env.CLOUDHELM_GO ?? (existsSync(bundled) ? bundled : 'go');
const version = execFileSync(go, ['version'], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } }).trim();
if (!/^go version go1\.27\.3 /u.test(version)) throw new Error('Native helper requires the pinned Go 1.27.3 toolchain');
const destination = path.join(root, 'apps/desktop/resources/native');
await mkdir(destination, { recursive: true });
const artifacts = [];
for (const arch of ['amd64', 'arm64']) {
  const filename = `cloudhelm-helper-linux-${arch}`;
  const target = path.join(destination, filename);
  execFileSync(go, ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', target,
    './packages/adapters/native/cmd/cloudhelm-helper'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, GOTOOLCHAIN: 'local', GOOS: 'linux', GOARCH: arch, CGO_ENABLED: '0' }
  });
  const data = await readFile(target);
  if (data.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error('Native helper is not an ELF executable');
  artifacts.push({ platform: 'linux', arch, filename, size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), protocolVersion: 1 });
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ protocolVersion: 1, toolchain: 'go1.27.3', artifacts }, null, 2) + '\n');
