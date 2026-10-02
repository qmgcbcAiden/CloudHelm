import type { RuntimeMessage } from '@cloudhelm/contracts/runtime';
import type { ParentPort } from 'electron';
import { WorkerServer } from './server.js';

const parent = (process as typeof process & { parentPort?: ParentPort }).parentPort;
if (!parent) throw new Error('CloudHelm runtime must run in an Electron utility process');
const server = new WorkerServer((message) => parent.postMessage(message));

parent.on('message', (event) => {
  const message = event.data as RuntimeMessage;
  if ('logResult' in message) { server.resolveLog(message.logResult); return; }
  if (!('call' in message)) return;
  void server.dispatch(message.call).then(
    (result) => parent.postMessage({ id: message.id, result }),
    (error: unknown) => parent.postMessage({ id: message.id,
      error: error instanceof Error ? error.message : String(error),
      hostFingerprint: error && typeof error === 'object' && 'fingerprint' in error ? String(error.fingerprint) : undefined
    })
  );
});
