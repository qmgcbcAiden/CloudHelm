import { cleanupNativeRuntime, installNativeRuntime, type InstalledNativeRuntime } from './native-runtime.js';
import type { NativeArtifact, RuntimeOperationPlan } from '@cloudhelm/core';
import { openIntegratedShell } from './shell-integration.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper } from 'ssh2';

export class HostKeyError extends Error {
  constructor(readonly fingerprint: string, readonly expected?: string) {
    super(expected ? 'SSH host key changed' : 'SSH host key is not trusted yet');
  }
}

export interface SshHost {
  id: string;
  label: string;
  address: string;
  port: number;
  username: string;
  auth: 'agent' | 'private-key' | 'password';
  privateKeyPath?: string;
  jumpHostId?: string;
  fingerprint?: string;
}

export interface AuthMaterial {
  password?: string;
  passphrase?: string;
}

export interface SshLoginPrompt {
  hostId: string;
  username: string;
  text: string;
  echo: boolean;
}

export type SshLoginChallenge = (prompt: SshLoginPrompt) => Promise<string | null>;

async function connectClient(host: SshHost, secret: AuthMaterial, socket?: ClientChannel, challenge?: SshLoginChallenge, signal?: AbortSignal): Promise<Client> {
  signal?.throwIfAborted();
  let observed: string | undefined;
  const config: ConnectConfig = {
    host: host.address, port: host.port, username: host.username, sock: socket,
    // A keyboard-interactive challenge can remain open while the user reads the
    // server prompt and enters an OTP. Its UI request expires after two minutes.
    readyTimeout: challenge ? 150_000 : 20_000,
    keepaliveInterval: 15_000, keepaliveCountMax: 3, tryKeyboard: !!challenge,
    hostVerifier(key: Buffer) {
      observed = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
      return observed === host.fingerprint;
    }
  };
  if (host.auth === 'agent') {
    const agent = process.env.SSH_AUTH_SOCK;
    if (!agent) throw new Error('SSH Agent is unavailable');
    config.agent = agent;
  } else if (host.auth === 'private-key') {
    if (!host.privateKeyPath) throw new Error('Private key path is required');
    config.privateKey = await readFile(host.privateKeyPath);
    if (secret.passphrase) config.passphrase = secret.passphrase;
  } else {
    if (!secret.password) throw new Error('SSH password is required');
    config.password = secret.password;
  }
  return new Promise((resolve, reject) => {
    const client = new Client();
    if (challenge) client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      void (async () => {
        const answers: string[] = [];
        for (const prompt of prompts) {
          const answer = await challenge({ hostId: host.id, username: host.username, text: prompt.prompt, echo: !!prompt.echo });
          if (answer === null) { finish([]); return; }
          answers.push(answer);
        }
        finish(answers);
      })().catch(() => finish([]));
    });
    const fail = (error: Error) => {
      signal?.removeEventListener('abort', abort);
      client.on('error', () => {});
      client.end();
      reject(observed && observed !== host.fingerprint ? new HostKeyError(observed, host.fingerprint) : error);
    };
    const abort = () => fail(new Error('SSH connection timed out'));
    client.once('ready', () => {
      signal?.removeEventListener('abort', abort);
      client.removeListener('error', fail);
      client.on('error', () => client.end());
      resolve(client);
    });
    client.once('error', fail);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { client.connect(config); }
    catch (error) { fail(error instanceof Error ? error : new Error('SSH connection failed')); }
  });
}

async function forwardSocket(client: Client, host: SshHost, signal?: AbortSignal): Promise<ClientChannel> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { settled = true; reject(new Error('SSH connection timed out')); };
    signal?.addEventListener('abort', abort, { once: true });
    client.forwardOut('127.0.0.1', 0, host.address, host.port, (error, channel) => {
      signal?.removeEventListener('abort', abort);
      if (settled) { channel?.end(); return; }
      settled = true;
      if (error) reject(error); else resolve(channel);
    });
  });
}

export class SshTransport {
  private readonly connections = new Map<string, Client>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly onDisconnected: (hostId: string) => void = () => {}) {}

  async connect(host: SshHost, secret: AuthMaterial, jump?: { host: SshHost; secret: AuthMaterial }, challenge?: SshLoginChallenge, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.disconnect(host.id);
    let socket: ClientChannel | undefined;
    if (jump) {
      let jumpClient = this.connections.get(jump.host.id);
      if (!jumpClient) {
        jumpClient = await connectClient(jump.host, jump.secret, undefined, challenge, signal);
        if (signal?.aborted) { jumpClient.end(); signal.throwIfAborted(); }
        this.registerConnection(jump.host.id, jumpClient);
      }
      socket = await forwardSocket(jumpClient, host, signal);
    }
    let client: Client;
    try { client = await connectClient(host, secret, socket, challenge, signal); }
    catch (error) { socket?.end(); throw error; }
    if (signal?.aborted) { client.end(); signal.throwIfAborted(); }
    this.registerConnection(host.id, client);
  }

  private registerConnection(hostId: string, client: Client): void {
    if (this.connections.has(hostId)) this.disconnect(hostId);
    this.connections.set(hostId, client);
    this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
    client.once('close', () => {
      if (this.connections.get(hostId) !== client) return;
      this.connections.delete(hostId);
      this.forgetNativeHost(hostId);
      this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
      this.onDisconnected(hostId);
    });
  }

  isConnected(hostId: string): boolean { return this.connections.has(hostId); }
  private readonly runtimes = new Map<string, InstalledNativeRuntime>();

  async nativeArchitecture(hostId: string): Promise<NativeArtifact['arch']> {
    const result = await this.execFixed(hostId, 'uname -s; uname -m');
    const lines = result.output.trim().split(/\r?\n/u);
    if (result.exitCode !== 0 || lines.length !== 2 || lines[0] !== 'Linux') throw new Error('Agent operations require Linux; business operation not started');
    if (lines[1] === 'x86_64') return 'amd64';
    if (lines[1] === 'aarch64' || lines[1] === 'arm64') return 'arm64';
    throw new Error('Unsupported remote architecture; business operation not started');
  }

  nativeInfo(hostId: string, sessionId: string, terminalGeneration: number): InstalledNativeRuntime | undefined {
    const installed = this.runtimes.get(JSON.stringify([hostId, sessionId, terminalGeneration]));
    return installed?.generation === this.connectionGeneration(hostId) ? installed : undefined;
  }

  async installNative(hostId: string, plan: RuntimeOperationPlan, bytes: Buffer, assertAuthorized: () => void, signal?: AbortSignal, terminalGeneration = 1): Promise<void> {
    const generation = this.connectionGeneration(hostId);
    const current = () => { assertAuthorized(); if (generation !== this.connectionGeneration(hostId)) throw new Error('SSH connection changed'); };
    await installNativeRuntime(plan, bytes, (command) => this.openPipe(hostId, command), current, signal);
    current();
    this.runtimes.set(JSON.stringify([hostId, plan.sessionId, terminalGeneration]), { hostId, terminalGeneration,
      artifact: plan.artifact, executable: plan.executable, directory: plan.directory, sessionId: plan.sessionId, generation });
  }

  async cleanupNative(hostId: string, plan: RuntimeOperationPlan, terminalGeneration: number, assertAuthorized: () => void): Promise<void> {
    const installed = this.nativeInfo(hostId, plan.sessionId, terminalGeneration);
    if (!installed || installed.directory !== plan.directory || installed.artifact.sha256 !== plan.artifact.sha256)
      throw new Error('Runtime cleanup ownership changed');
    await cleanupNativeRuntime(plan, (command) => this.execFixed(hostId, command), assertAuthorized);
    this.runtimes.delete(JSON.stringify([hostId, plan.sessionId, terminalGeneration]));
  }
  private forgetNativeHost(hostId: string): void {
    for (const [key, value] of this.runtimes) if (value.hostId === hostId) this.runtimes.delete(key);
  }

  connectionGeneration(hostId: string): number { return this.generations.get(hostId) ?? 0; }

  async execFixed(hostId: string, command: string): Promise<{ exitCode: number; output: string }> {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    return new Promise((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) { reject(error); return; }
        let output = '';
        let exitCode = -1;
        const timer = setTimeout(() => { channel.close(); reject(new Error('远端环境检查超时；业务命令未发送')); }, 15_000);
        channel.on('error', (error: Error) => { clearTimeout(timer); reject(error); });
        channel.on('data', (data: Buffer) => { output = (output + data.toString('utf8')).slice(-4096); });
        channel.stderr.on('data', (data: Buffer) => { output = (output + data.toString('utf8')).slice(-4096); });
        channel.on('exit', (code: number) => { exitCode = code; });
        channel.on('close', () => { clearTimeout(timer); resolve({ exitCode, output }); });
      });
    });
  }

  async openPipe(hostId: string, command: string): Promise<ClientChannel> {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    return new Promise((resolve, reject) => {
      client.exec(command, (error, channel) => error ? reject(error) : resolve(channel));
    });
  }

  /** Lookup only: installation must already have its own SafetyGate authorization. */
  async prepareCommandProgram(hostId: string, _source: string, assertAuthorized: () => void,
    binding?: { sessionId: string; generation: number }): Promise<string> {
    assertAuthorized();
    const runtime = binding ? this.nativeInfo(hostId, binding.sessionId, binding.generation) : undefined;
    if (!runtime) throw new Error('No authorized native runtime is installed for this connection');
    return runtime.executable;
  }

  /** Runtime ownership and cleanup belong to the task resource journal, not a terminal. */
  async removeCommandProgram(_hostId: string, _executable: string): Promise<void> {}

  async integratedShell(hostId: string, cols = 100, rows = 30) {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    return openIntegratedShell(client, cols, rows);
  }

  async shell(hostId: string, cols = 100, rows = 30): Promise<ClientChannel> {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => error ? reject(error) : resolve(channel));
    });
  }

  async list(hostId: string, directory: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>> {
    return this.withSftp(hostId, async (sftp) => {
      const files = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
        sftp.readdir(directory, (error, entries) => error ? reject(error) : resolve(entries));
      });
      return files.map((file) => ({ name: file.filename, isDirectory: file.attrs.isDirectory(), size: file.attrs.size }));
    });
  }

  private async withSftp<T>(hostId: string, action: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, instance) => error ? reject(error) : resolve(instance));
    });
    try { return await action(sftp); }
    finally { sftp.end(); }
  }

  disconnect(hostId: string): void {
    const client = this.connections.get(hostId);
    if (!client) return;
    this.connections.delete(hostId);
    this.forgetNativeHost(hostId);
    this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
    client.end();
    this.onDisconnected(hostId);
  }

  close(): void {
    for (const hostId of this.connections.keys()) this.disconnect(hostId);
  }
}
