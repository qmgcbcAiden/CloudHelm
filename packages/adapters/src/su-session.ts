import { PrivilegeError, type NativeBinding, type PrivilegeFeedback } from '@cloudhelm/core';
import { Duplex, PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ClientChannel } from 'ssh2';
import type { SshTransport } from './ssh-transport.js';
import type { CommandTransport } from './ssh-command-terminal.js';
export interface SuBootstrapContext extends NativeBinding { rootDirectory: string; artifactSha256: string }

/** Isolated root broker. Only its authentication phase accepts secret answers. */
export class SuSession implements CommandTransport {
  private active?: ClientChannel;
  private broker?: ClientChannel;
  private program?: string;
  private ready = false;
  private closed = false;
  private challenge?: string;
  private binding?: NativeBinding;
  private runtime?: SuBootstrapContext;
  private cleanup?: { resolve: () => void; reject: (error: Error) => void };
  private cleanupRequested = false;
  private readonly generation: number;
  private failConnect?: (code: PrivilegeFeedback['code']) => void;
  private readonly abort = () => this.failConnect ? this.failConnect('cancelled') : this.close();
  constructor(private readonly ssh: SshTransport, private readonly hostId: string,
    private readonly signal: AbortSignal, private readonly onClosed: () => void) {
    this.generation = ssh.connectionGeneration(hostId);
    signal.addEventListener('abort', this.abort, { once: true });
  }
  async connect(authenticate: (id: string) => Promise<string | null>, current: () => void, context?: SuBootstrapContext): Promise<void> {
    current(); this.signal.throwIfAborted();
    if (!context || context.version !== 1 || !context.rootDirectory.startsWith('/') || !/^[a-f0-9]{64}$/u.test(context.artifactSha256))
      throw new PrivilegeError({ method: 'su', stage: 'preparation', code: 'unsupported', source: 'transport', businessCommand: 'not-started', recovery: 'user-action' });
    this.binding = { version: 1, operationId: context.operationId, sessionId: context.sessionId, generation: context.generation };
    this.runtime = context;
    this.program = await this.ssh.prepareCommandProgram(this.hostId, '', current, this.binding);
    current(); this.signal.throwIfAborted();
    const broker = await this.ssh.openPipe(this.hostId, `'${this.program.replace(/'/gu, `'"'"'`)}' --su-broker`);
    if (this.closed || this.signal.aborted) { broker.end(); broker.close(); throw new Error('Root session canceled'); }
    this.broker = broker;
    await new Promise<void>((resolve, reject) => {
      const decoder = new StringDecoder('utf8'); let buffer = ''; let settled = false;
      const timer = setTimeout(() => fail('timeout'), 125_000);
      const fail = (code: PrivilegeFeedback['code'] = 'authentication-unconfirmed') => {
        clearTimeout(timer); this.failConnect = undefined;
        if (!settled) { settled = true; reject(new PrivilegeError({ method: 'su', stage: 'authentication', code,
          source: 'transport', businessCommand: 'not-started', recovery: 'user-action' })); }
        this.close();
      };
      this.failConnect = fail;
      broker.on('close', () => fail('transport-unavailable')); broker.on('error', () => fail('transport-unavailable')); broker.stderr.on('data', () => fail('unsupported'));
      broker.on('data', (chunk: Buffer) => {
        if (this.closed) return;
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) >= 2 * 1024 * 1024) { fail(); return; }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.version !== this.binding!.version || event.operationId !== this.binding!.operationId || event.sessionId !== this.binding!.sessionId
              || event.generation !== this.binding!.generation) { fail(); return; }
            if (event.type === 'ready' && event.uid === 0 && event.euid === 0 && event.rootDirectory === context.rootDirectory && !this.ready) {
              current(); this.signal.throwIfAborted(); this.ready = true; this.challenge = undefined;
              settled = true; this.failConnect = undefined; clearTimeout(timer); resolve();
            } else if (event.type === 'auth' && !this.ready && !this.challenge && /^[a-f0-9]{32}$/u.test(event.id)) {
              this.challenge = event.id;
              void authenticate(event.id).then((answer) => {
                if (this.closed || this.ready || this.challenge !== event.id) return;
                current(); this.signal.throwIfAborted(); this.challenge = undefined;
                if (answer === null) { fail('cancelled'); return; }
                broker.write(JSON.stringify({ ...this.binding, type: 'answer', id: event.id, answer }) + '\n');
              }).catch((error) => fail(error instanceof PrivilegeError ? error.feedback.code : 'authentication-unconfirmed'));
            } else if (event.type === 'auth-close' && typeof event.id === 'string') {
              if (this.challenge === event.id) this.challenge = undefined;
            } else if (event.type === 'output' && this.ready && typeof event.data === 'string' && this.active) {
              this.active.push(Buffer.from(event.data));
            } else if (event.type === 'cleanup-confirmed' && this.cleanup && event.rootDirectory === context.rootDirectory && event.sha256 === context.artifactSha256) {
              const cleanup = this.cleanup; this.cleanup = undefined; cleanup.resolve();
            } else if (event.type === 'error' && ['timeout', 'unsupported', 'cancelled', 'authentication-unconfirmed', 'transport-unavailable'].includes(event.code)) {
              fail(event.code); return;
            } else { fail(); return; }
          } catch { fail(); return; }
        }
      });
      current(); this.signal.throwIfAborted();
      broker.write(JSON.stringify({ ...this.binding, type: 'connect', payload: { rootDirectory: context.rootDirectory, sha256: context.artifactSha256 } }) + '\n');
    });
  }
  connectionGeneration(): number { return this.closed ? 2 : 1; }
  async prepareCommandProgram(_id: string, _source: string, current: () => void): Promise<string> {
    current(); this.assertReady(); return 'fixed-root-command-program';
  }
  async removeCommandProgram(): Promise<void> { /* Embedded program; session owns cleanup. */ }
  async cleanupRuntime(current: () => void): Promise<void> {
    current(); this.assertReady();
    if (this.active) throw new Error('Root command is still active; runtime cleanup is unavailable');
    this.cleanupRequested = true;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.cleanup = undefined; reject(new Error('Root cleanup outcome is unknown')); }, 10_000);
      this.cleanup = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      try {
        current();
        this.broker!.write(JSON.stringify({ ...this.binding, type: 'cleanup', rootDirectory: this.runtime!.rootDirectory, sha256: this.runtime!.artifactSha256 }) + '\n');
      } catch (error) { const cleanup = this.cleanup; this.cleanup = undefined; cleanup?.reject(error instanceof Error ? error : new Error('Root cleanup unavailable')); }
    });
  }
  async shell(): Promise<ClientChannel> { throw new Error('Root sessions cannot become an unaudited interactive shell'); }
  async openPipe(_hostId?: string, command?: string): Promise<ClientChannel> {
    this.assertReady();
    if (this.active) throw new Error('Root command already active');
    const broker = this.broker!;
    const binding = this.binding!;
    let ended = false;
    const end = () => {
      if (ended) return; ended = true;
      if (this.active === channel) this.active = undefined;
      if (!this.closed) broker.write(JSON.stringify({ ...binding, type: 'end' }) + '\n');
    };
    const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) {
      if (ended) { callback(new Error('Root command ended')); return; }
      broker.write(JSON.stringify({ ...binding, type: 'control', data: chunk.toString('utf8') }) + '\n', callback);
    }, final(callback) { end(); callback(); }, destroy(_error, callback) { end(); callback(); } });
    const channel = Object.assign(stream, { stderr: new PassThrough(), close: () => { end(); stream.destroy(); } }) as unknown as ClientChannel;
    this.active = channel;
    broker.write(JSON.stringify({ ...binding, type: 'start', mode: command?.endsWith('--files') ? 'files' : 'serve' }) + '\n');
    return channel;
  }
  private assertReady(): void {
    if (!this.ready || this.closed || this.cleanupRequested || this.signal.aborted || this.generation !== this.ssh.connectionGeneration(this.hostId)) throw new Error('Root session expired');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.challenge = undefined;
    const cleanup = this.cleanup; this.cleanup = undefined; cleanup?.reject(new Error('Root cleanup outcome is unknown'));
    const fail = this.failConnect; this.failConnect = undefined; fail?.('cancelled');
    this.signal.removeEventListener('abort', this.abort);
    this.active?.destroy(); this.broker?.end(); this.broker?.close();
    this.onClosed();
    // Closing never deletes a runtime. Only an independently approved cleanup
    // request may remove the root copy; unresolved resources remain journaled.
  }
}
