import process from 'node:process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyElf(bytes, arch) {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1
    || bytes.readUInt16LE(18) !== (arch === 'amd64' ? 62 : arch === 'arm64' ? 183 : -1)) throw new Error('Unexpected ELF architecture');
  const offset = Number(bytes.readBigUInt64LE(32)); const size = bytes.readUInt16LE(54); const count = bytes.readUInt16LE(56);
  if (!Number.isSafeInteger(offset) || size < 56 || offset + count * size > bytes.length) throw new Error('Invalid ELF program headers');
  for (let i = 0; i < count; i++) {
    const type = bytes.readUInt32LE(offset + i * size);
    if (type === 2 || type === 3) throw new Error('Remote helper must not depend on a dynamic loader or runtime libraries');
  }
}
export async function verifyNativeBundle(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.protocolVersion !== 1 || manifest.toolchain !== 'go1.27.3' || manifest.artifacts?.length !== 2) throw new Error('Native bundle manifest mismatch');
  for (const arch of ['amd64', 'arm64']) {
    const record = manifest.artifacts.find((item) => item.arch === arch);
    if (!record || record.filename !== `cloudhelm-helper-linux-${arch}` || record.platform !== 'linux' || record.protocolVersion !== 1) throw new Error('Native bundle architecture missing');
    const bytes = await readFile(path.join(root, record.filename)); verifyElf(bytes, arch);
    if (bytes.length !== record.size || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error('Native bundle checksum mismatch');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? path.resolve(import.meta.dirname, '../apps/desktop/resources/native');
  await verifyNativeBundle(root);
  console.log('Both remote helper architectures verified: static ELF, SHA-256 and protocol 1.');
}
