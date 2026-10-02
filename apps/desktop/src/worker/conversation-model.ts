import { createModelCatalog } from '@cloudhelm/adapters';
import type { RuntimeProfile } from '@cloudhelm/contracts/runtime';

/** A selection change becomes active only at a model request boundary. */
export class ConversationModel {
  private selected;
  private active;

  constructor(profile: RuntimeProfile) {
    this.selected = this.resolve(profile);
    this.active = this.selected;
  }

  select(profile: RuntimeProfile): void { this.selected = this.resolve(profile); }
  setReviewKey(jevKey?: string): void {
    this.selected = { ...this.selected, profile: { ...this.selected.profile, jevKey } };
  }
  prepare() { this.active = this.selected; return this.active; }
  current() { return this.active; }

  private resolve(profile: RuntimeProfile) {
    const catalog = createModelCatalog(profile);
    const model = catalog.getModel(profile.provider, profile.modelId);
    if (!model) throw new Error('所选模型不在 Pi 模型目录中');
    return { profile: { ...profile }, catalog, model };
  }
}

export async function testModelConnection(profile: RuntimeProfile): Promise<{ latencyMs: number }> {
  const { catalog, model } = new ConversationModel(profile).current();
  const start = Date.now();
  const result = await catalog.completeSimple(model, {
    messages: [{ role: 'user', content: 'Reply with OK.', timestamp: start }]
  }, { apiKey: profile.apiKey, maxTokens: 64, signal: AbortSignal.timeout(20_000) });
  if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error('模型连接测试失败，请检查 Key、地址和模型权限');
  return { latencyMs: Date.now() - start };
}
