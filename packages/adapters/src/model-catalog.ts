import { createProvider, envApiKeyAuth, type Model, type MutableModels } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export interface ModelSelection { provider: string; modelId: string; baseUrl?: string }

/** The visible API-key catalog comes from the same Pi registry used at runtime. */
export function listModelProviders(): Array<{ id: string; name: string; defaultBaseUrl?: string; models: Array<{ id: string; name: string }> }> {
  const catalog = builtinModels();
  const providers = catalog.getProviders().filter((provider) => provider.auth.apiKey && catalog.getModels(provider.id).length);
  return [...providers.map((provider) => {
    const models = catalog.getModels(provider.id);
    return {
      id: provider.id, name: provider.name,
      defaultBaseUrl: provider.baseUrl || models[0]?.baseUrl || undefined,
      models: models.map((model) => ({ id: model.id, name: model.name }))
    };
  }), { id: 'cloudhelm-custom', name: '自定义 OpenAI 兼容', models: [] }];
}

export function createModelCatalog(selection: ModelSelection): MutableModels {
  const models = builtinModels();
  if (selection.provider !== 'cloudhelm-custom') {
    const provider = models.getProvider(selection.provider);
    if (provider && selection.baseUrl) {
      const baseUrl = validModelUrl(selection.baseUrl);
      models.setProvider({
        ...provider, baseUrl,
        getModels: () => provider.getModels().map((model) => ({ ...model, baseUrl })),
        getAllModels: provider.getAllModels
          ? () => provider.getAllModels!().map((model) => ({ ...model, baseUrl }))
          : undefined
      });
    }
    return models;
  }
  if (!selection.baseUrl) throw new Error('Custom model URL is required');
  const baseUrl = validModelUrl(selection.baseUrl);
  const model: Model<'openai-completions'> = {
    id: selection.modelId, name: selection.modelId, provider: 'cloudhelm-custom', api: 'openai-completions',
    baseUrl, input: ['text'], reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 8192
  };
  models.setProvider(createProvider({ id: 'cloudhelm-custom', name: 'Custom OpenAI compatible',
    baseUrl: model.baseUrl, auth: { apiKey: envApiKeyAuth('Custom API Key', []) }, models: [model], api: openAICompletionsApi() }));
  return models;
}

export function validModelUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Model API address must use HTTPS or local HTTP');
  }
  return url.toString().replace(/\/$/u, '');
}
