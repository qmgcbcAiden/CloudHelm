import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { HostDraftSchema, type HostConnectionTestInput, type HostConnectionTestResult, type HostDraft, type HostView } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeHostTestResult } from '@cloudhelm/contracts/runtime';

interface HostSource { getHost(id: string): HostView; runtimeHost(id: string): RuntimeHost }
interface TrustChallenge {
  digest: string; expiresAt: number; fingerprints: Partial<Record<'host' | 'jump', string>>;
}

function probeHost(draft: HostDraft, id: string, fingerprint?: string, secret?: string): RuntimeHost {
  // Copy only the public form fields: renderer-supplied fingerprints are never trusted.
  return { id, label: draft.label, address: draft.address, port: draft.port, username: draft.username,
    auth: draft.auth, privateKeyPath: draft.privateKeyPath, fingerprint, secret,
    status: 'disconnected', protectedPaths: [], policyRevision: 1, defaultMode: 'ai-review' };
}

/** Tests drafts without saving configuration, credentials, trust, or connection status. */
export class HostConnectionTester {
  private readonly challenges = new Map<string, TrustChallenge>();
  private readonly digestKey = randomBytes(32);
  private busy = false;

  constructor(private readonly source: HostSource,
    private readonly run: (host: RuntimeHost, jump?: RuntimeHost) => Promise<RuntimeHostTestResult>) {}

  async test(input: HostConnectionTestInput): Promise<HostConnectionTestResult> {
    if (this.busy) throw new Error('Operation is already in progress');
    this.busy = true;
    try { return await this.attempt(input); }
    finally { this.busy = false; }
  }

  private prepare(input: HostConnectionTestInput): { host: RuntimeHost; jump?: RuntimeHost } {
    if (!input || !Value.Check(HostDraftSchema, input.host)
      || [input.editingHostId, input.secret, input.trustRequestId].some((value) => value !== undefined && typeof value !== 'string')) {
      throw new Error('Invalid host settings');
    }
    const draft = input.host;
    const previous = input.editingHostId ? this.source.getHost(input.editingHostId) : undefined;
    if (previous?.archived) throw new Error('Invalid host settings');
    const sameEndpoint = previous?.address === draft.address && previous.port === draft.port;
    const reuseSecret = sameEndpoint && previous.username === draft.username && previous.auth === draft.auth
      && previous.privateKeyPath === draft.privateKeyPath && previous.jumpHostId === draft.jumpHostId;
    const secret = input.secret || (reuseSecret && draft.auth !== 'agent' ? this.source.runtimeHost(previous.id).secret : undefined);
    const host = probeHost(draft, 'test-target', sameEndpoint ? previous.fingerprint : undefined, secret);
    if (!draft.jumpHostId) return { host };
    const savedJump = this.source.getHost(draft.jumpHostId);
    if (savedJump.archived || savedJump.jumpHostId || savedJump.id === previous?.id) {
      throw new Error('Choose an active direct host as the jump host');
    }
    const jump = probeHost(savedJump, 'test-jump', savedJump.fingerprint, this.source.runtimeHost(savedJump.id).secret);
    return { host, jump };
  }

  private async attempt(input: HostConnectionTestInput): Promise<HostConnectionTestResult> {
    const { host, jump } = this.prepare(input);
    const digest = createHmac('sha256', this.digestKey).update(JSON.stringify({ host, jump })).digest('hex');
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= Date.now()) this.challenges.delete(id);
    let fingerprints: TrustChallenge['fingerprints'] = {};
    if (input.trustRequestId) {
      const challenge = this.challenges.get(input.trustRequestId);
      this.challenges.delete(input.trustRequestId);
      if (!challenge || challenge.digest !== digest) throw new Error('Host connection test confirmation expired');
      fingerprints = challenge.fingerprints;
      if (fingerprints.host) host.fingerprint = fingerprints.host;
      if (jump && fingerprints.jump) jump.fingerprint = fingerprints.jump;
    }
    const result = await this.run(host, jump);
    if (result.status !== 'trust-required') return result;
    const target = result.stage === 'jump' ? jump! : host;
    const requestId = randomUUID();
    const expiresAt = Date.now() + 120_000;
    if (this.challenges.size >= 8) this.challenges.delete(this.challenges.keys().next().value!);
    this.challenges.set(requestId, { digest, expiresAt, fingerprints: { ...fingerprints, [result.stage]: result.fingerprint } });
    return { ...result, requestId, expiresAt, address: target.address, port: target.port };
  }
}
